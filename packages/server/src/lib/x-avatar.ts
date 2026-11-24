import { readFile } from "node:fs/promises";
import { cardAssetPath } from "./card-assets.ts";
import { xPhotoCandidates } from "@blast/core/lib/x-photo-url.ts";

import {
  createApprovedXAvatarSnapshot,
  type ApprovedXAvatarSnapshot,
  type AvatarMediaType,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";

const MAX_AVATAR_BYTES = 5_000_000;

/**
 * Uploaded portraits live on pbs.twimg.com. An account that never set one
 * carries X's stock silhouette from abs.twimg.com, which must claim too.
 */
const X_AVATAR_ORIGINS = ["https://pbs.twimg.com", "https://abs.twimg.com"];

/** `code` is what the completion route logs; messages never reach a log line. */
export class XAvatarError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "XAvatarError";
    this.code = code;
  }
}

function approvedUrl(reference: string | null): URL {
  if (!reference) throw new XAvatarError("AVATAR_REQUIRED", "A connected X avatar is required.");
  const url = new URL(reference);
  if (
    !X_AVATAR_ORIGINS.includes(url.origin) ||
    url.username || url.password
  ) {
    throw new XAvatarError("AVATAR_HOST_NOT_APPROVED", "The connected X avatar host is not approved.");
  }
  return url;
}

async function downloadAvatar(
  url: URL,
  fetcher: typeof fetch,
): Promise<ApprovedXAvatarSnapshot | null> {
  const response = await fetcher(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  // A deleted photo cannot be recovered. Transient failures must remain
  // retryable instead of permanently caching the old thumbnail as repaired.
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return null;
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
  const length = Number(response.headers.get("content-length"));
  if (
    !response.ok || !response.body ||
    !(["image/jpeg", "image/png", "image/webp"] as unknown[]).includes(mediaType) ||
    (Number.isFinite(length) && length > MAX_AVATAR_BYTES)
  ) {
    await response.body?.cancel();
    throw new XAvatarError("AVATAR_NOT_SNAPSHOTTED", "The connected X avatar could not be snapshotted.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_AVATAR_BYTES) {
        throw new XAvatarError("AVATAR_TOO_LARGE", "The connected X avatar exceeds the snapshot limit.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return createApprovedXAvatarSnapshot(Buffer.concat(chunks), mediaType as AvatarMediaType);
}

/**
 * The first candidate size X answers for, in order (original, then 400 px), or
 * null when none exists. A transient failure throws so the claim is retried.
 */
export async function originalXAvatar(
  reference: string | null,
  fetcher: typeof fetch = fetch,
): Promise<ApprovedXAvatarSnapshot | null> {
  const approved = approvedUrl(reference);
  for (const candidate of xPhotoCandidates(approved.href)) {
    const avatar = await downloadAvatar(new URL(candidate), fetcher);
    if (avatar) return avatar;
  }
  return null;
}

/** The Blast pilot stands in when X has no photo for the account. */
export async function placeholderAvatar(): Promise<ApprovedXAvatarSnapshot> {
  const bytes = await readFile(cardAssetPath("default-avatar.png"));
  return createApprovedXAvatarSnapshot(bytes, "image/png");
}

/**
 * Snapshot the largest available source at claim time, with the provider URL
 * as fallback. No photo at all, or one X has since deleted, gets the
 * placeholder; an unapproved host or a failed download still throws.
 */
export async function snapshotApprovedXAvatar(
  reference: string | null,
  fetcher: typeof fetch = fetch,
  placeholder: () => Promise<ApprovedXAvatarSnapshot> = placeholderAvatar,
): Promise<ApprovedXAvatarSnapshot> {
  if (!reference) return placeholder();
  const avatar = await originalXAvatar(reference, fetcher) ??
    await downloadAvatar(approvedUrl(reference), fetcher);
  return avatar ?? placeholder();
}
