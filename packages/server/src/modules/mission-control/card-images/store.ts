import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { CardImageStoreSettings } from "@blast/server/modules/mission-control/card-images/settings.ts";

import {
  get,
  put,
  type BlobAccessType,
  type GetCommandOptions,
  type PutCommandOptions,
} from "@vercel/blob";

export type CardImageStoreKind = "vercel-blob" | "filesystem";

/** Object storage for rendered card PNGs, addressed by a deterministic pathname. */
export interface CardImageStore {
  readonly kind: CardImageStoreKind;
  /** The stored bytes, or null when no object exists at `pathname`. */
  read(pathname: string): Promise<Buffer | null>;
  /** Stores `bytes` at exactly `pathname`, replacing any earlier object there. */
  write(pathname: string, bytes: Buffer): Promise<Readonly<{ url: string }>>;
}

export type BlobPut = (
  pathname: string,
  body: Buffer,
  options: PutCommandOptions,
) => Promise<Readonly<{ url: string }>>;

export type BlobGet = (
  pathname: string,
  options: GetCommandOptions,
) => Promise<Readonly<{ statusCode: number; stream: ReadableStream<Uint8Array> | null }> | null>;

/**
 * The Blob SDK's errors never set `name`, so they all log as "Error". Sorted by
 * their fixed message text into a short code that is safe to log (the message
 * itself may name a pathname or a rate-limit window and is never logged).
 */
const BLOB_ERROR_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Vercel Blob: File is too large,/, "blob_file_too_large"],
  [/^Vercel Blob: Content type mismatch,/, "blob_content_type"],
  [/^Vercel Blob: Access denied,/, "blob_access_denied"],
  [/^Vercel Blob: Cannot use (?:private access on a public store|public access on a private store)\./, "blob_access_mismatch"],
  [/^Vercel Blob: (?:No read-write token found|No blob credentials found|Invalid token)/, "blob_token_invalid"],
  [/^Vercel Blob: This store does not exist/, "blob_store_not_found"],
  [/^Vercel Blob: This store has been suspended/, "blob_store_suspended"],
  [/^Vercel Blob: The blob service is currently not available/, "blob_service_unavailable"],
  [/^Vercel Blob: Too many requests/i, "blob_rate_limited"],
  [/^Vercel Blob: The request was aborted/, "blob_aborted"],
  [/^Vercel Blob: Unknown error/, "blob_unknown"],
];

/** Private reads call fetch directly: their only failure text is `Failed to fetch blob: <status> <text>`. */
const BLOB_FETCH_STATUS = /^Vercel Blob: Failed to fetch blob: (\d{3})\b/;

/** Discard provider text and objects; only fixed codes may reach logs. */
export function classifyBlobError(error: unknown): Error & { code: string } {
  const message = error instanceof Error ? error.message : "";
  const status = BLOB_FETCH_STATUS.exec(message)?.[1];
  const known = BLOB_ERROR_CODES.find(([pattern]) => pattern.test(message))?.[1];
  const code = status ? `blob_http_${status}` : (known ?? "blob_error");
  return Object.assign(new Error(`Card image store failed: ${code}.`), { code });
}

const ONE_YEAR_SECONDS = 31_536_000;
const BLOB_READ_TIMEOUT_MS = 5_000;
const BLOB_WRITE_TIMEOUT_MS = 10_000;

/**
 * Vercel Blob. Objects are written with the configured access (private by
 * default) and read back server-side with the store token; blob URLs stay in
 * the catalog and are never sent to clients. Renders are deterministic for a
 * pathname, so overwriting is allowed: it is how a lost catalog row heals.
 */
export class VercelBlobCardImageStore implements CardImageStore {
  readonly kind = "vercel-blob";
  readonly #access: BlobAccessType;
  readonly #get: BlobGet;
  readonly #put: BlobPut;
  readonly #token: string;

  constructor(input: Readonly<{
    access: BlobAccessType;
    get: BlobGet;
    put: BlobPut;
    token: string;
  }>) {
    this.#access = input.access;
    this.#get = input.get;
    this.#put = input.put;
    this.#token = input.token;
  }

  async read(pathname: string): Promise<Buffer | null> {
    const result = await this.#get(pathname, {
      abortSignal: AbortSignal.timeout(BLOB_READ_TIMEOUT_MS),
      access: this.#access,
      token: this.#token,
    }).catch((error: unknown) => {
      throw classifyBlobError(error);
    });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) {
      throw new Error(`Card image store answered ${result.statusCode} without a body.`);
    }
    try {
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    } catch (error) {
      throw classifyBlobError(error);
    }
  }

  async write(pathname: string, bytes: Buffer): Promise<Readonly<{ url: string }>> {
    const result = await this.#put(pathname, bytes, {
      abortSignal: AbortSignal.timeout(BLOB_WRITE_TIMEOUT_MS),
      access: this.#access,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: ONE_YEAR_SECONDS,
      contentType: "image/png",
      token: this.#token,
    }).catch((error: unknown) => {
      throw classifyBlobError(error);
    });
    return { url: result.url };
  }
}

/** A local directory, for development and load tests. Writes are atomic renames. */
export class FilesystemCardImageStore implements CardImageStore {
  readonly kind = "filesystem";
  readonly #root: string;

  constructor(directory: string) {
    this.#root = resolve(directory);
  }

  #path(pathname: string): string {
    const path = resolve(this.#root, pathname);
    if (!path.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Card image pathname escapes the image directory.");
    }
    return path;
  }

  async read(pathname: string): Promise<Buffer | null> {
    try {
      return await readFile(this.#path(pathname));
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(pathname: string, bytes: Buffer): Promise<Readonly<{ url: string }>> {
    const path = this.#path(pathname);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { url: pathToFileURL(path).href };
  }
}

/**
 * Vercel Blob when a blob token is set, a directory when one is set, otherwise
 * null: renders then live only in each instance's memory cache.
 */
export function cardImageStore(settings: CardImageStoreSettings): CardImageStore | null {
  if (settings.blobToken) {
    return new VercelBlobCardImageStore({ access: settings.access, get, put, token: settings.blobToken });
  }
  if (settings.directory) return new FilesystemCardImageStore(settings.directory);
  return null;
}
