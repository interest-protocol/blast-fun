import type { BlobAccessType } from "@vercel/blob";

import { boundedInteger } from "@blast/core/lib/config/bounded-integer.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export const CARD_RENDER_CONCURRENCY_DEFAULT = 2;
export const CARD_RENDER_QUEUE_DEFAULT = 16;

/** Where rendered cards are kept: Vercel Blob when `blobToken` is set, else `directory`, else nowhere. */
export type CardImageStoreSettings = Readonly<{
  blobToken: string | null;
  access: BlobAccessType;
  directory: string | null;
}>;

export type CardImageSettings = Readonly<{
  memoryCacheBytes: number;
  renderConcurrency: number;
  renderQueue: number;
  store: CardImageStoreSettings;
}>;

/**
 * Per instance: CARD_IMAGE_MEMORY_CACHE_BYTES bounds the PNG cache (default
 * 64 MiB, 0 disables), CARD_RENDER_CONCURRENCY the renders run at once
 * (default 2, 1–8), and CARD_RENDER_QUEUE the renders that may wait for one
 * (default 16, 0–64). The store: BLOB_READ_WRITE_TOKEN with
 * CARD_IMAGE_BLOB_ACCESS (`private`, the default, or `public`), else
 * CARD_IMAGE_DIRECTORY. A set but invalid value throws, naming the variable.
 */
export function cardImageSettingsFromEnvironment(environment: Environment): CardImageSettings {
  return Object.freeze({
    memoryCacheBytes: boundedInteger(environment, "CARD_IMAGE_MEMORY_CACHE_BYTES", 64 * 1024 * 1024, 0, 1024 * 1024 * 1024),
    renderConcurrency: boundedInteger(environment, "CARD_RENDER_CONCURRENCY", CARD_RENDER_CONCURRENCY_DEFAULT, 1, 8),
    renderQueue: boundedInteger(environment, "CARD_RENDER_QUEUE", CARD_RENDER_QUEUE_DEFAULT, 0, 64),
    store: Object.freeze({
      blobToken: environment.BLOB_READ_WRITE_TOKEN?.trim() || null,
      access: blobAccess(environment),
      directory: environment.CARD_IMAGE_DIRECTORY?.trim() || null,
    }),
  });
}

function blobAccess(environment: Environment): BlobAccessType {
  const access = environment.CARD_IMAGE_BLOB_ACCESS?.trim() || "private";
  if (access !== "private" && access !== "public") {
    throw new Error("CARD_IMAGE_BLOB_ACCESS must be private or public.");
  }
  return access;
}
