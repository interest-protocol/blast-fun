import type { StoredCover } from "@blast/server/modules/social/sales/contracts.ts";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { LaunchAssetRemover, LaunchAssetStore } from "@blast/server/modules/launch-assets/store.ts";
import { SALE_COVER_FIELD, SALE_COVER_HEIGHT, SALE_COVER_MAX_BYTES, SALE_COVER_TYPES, SALE_COVER_WIDTH } from "@blast/core/modules/social/contracts/sales.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialBody } from "@blast/server/modules/social/route-kit/route.ts";
import { squareImagePath, type SquareImageLimits } from "@blast/server/modules/social/square-image.ts";

const coverUrlSchema = z.string().regex(/^https:\/\/[^\s]{1,2040}$/);
const coverPartsSchema = z.tuple([z.tuple([z.literal(SALE_COVER_FIELD), z.instanceof(File)])]);

/**
 * A sale cover (R3-24) through the social image pipeline (`square-image.ts`),
 * widened to a 3:1 shape: PNG, JPEG or WebP up to 4 MB, a still image from
 * 128 to 4,096 pixels a side, stored as a 1536 × 512 WebP at quality 86 (the
 * centre kept). SVG is refused, as for every social upload: only re-encoded
 * pixels are ever served.
 */
export const SALE_COVER_IMAGE: SquareImageLimits = Object.freeze({
  types: SALE_COVER_TYPES,
  maxBytes: SALE_COVER_MAX_BYTES,
  minSide: 128,
  maxSide: 4_096,
  side: SALE_COVER_WIDTH,
  height: SALE_COVER_HEIGHT,
  quality: 86,
});

/** Where a published sale's covers live: one folder per sale, so a replaced cover's object is only ever that sale's. */
export function saleCoverFolder(presaleId: string): string {
  return `sale-covers/${presaleId}`;
}

/**
 * Where a Create draft's (or a Launch draft's) cover lives until it is published with it (R3-25).
 * Both draft tables write here, so a draft id is unique across them (each create refuses an id the other holds).
 */
export function draftCoverFolder(draftId: string): string {
  return `draft-covers/${draftId}`;
}

/** The public store covers go to (the launch-asset Blob store), which can also remove a replaced one. */
export type SaleCoverStore = Pick<LaunchAssetStore, "write"> & LaunchAssetRemover;


/**
 * Writes a sanitized cover at `<folder>/<sha256>.webp` (its content address
 * in that folder) and answers where it is, with its upload's size, or null
 * when the store failed or answered anything but an https URL (the caller's
 * `cover_upload_unavailable`).
 */
export async function storeCover(
  store: Pick<LaunchAssetStore, "write">,
  folder: string,
  image: Readonly<{ bytes: Buffer; contentType: "image/webp"; source: StoredCover["source"] }>,
): Promise<StoredCover | null> {
  const key = squareImagePath(folder, createHash("sha256").update(image.bytes).digest("hex"));
  let url: string;
  try {
    url = (await store.write(key, image.bytes, image.contentType)).url;
  } catch {
    return null;
  }
  return coverUrlSchema.safeParse(url).success
    ? { key, url, width: SALE_COVER_WIDTH, height: SALE_COVER_HEIGHT, source: image.source }
    : null;
}

/** Room for the multipart envelope around the file. */
const MULTIPART_OVERHEAD_BYTES = 16 * 1_024;

/**
 * The one `cover` file of a `multipart/form-data` body, and its declared
 * type. Another content type, an unreadable form, a text field, a second
 * part or a missing file is `invalid_request`; a body or file over 4 MB is
 * `body_too_large`, refused unread when its `Content-Length` says so.
 */
export async function readCoverUpload(request: Request): Promise<Readonly<{ bytes: Uint8Array; declared: string | null }>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") throw new SocialRouteError("invalid_request");
  const body = await readSocialBody(request, SALE_COVER_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new SocialRouteError("invalid_request");
  }
  const parts = coverPartsSchema.safeParse([...form.entries()]);
  if (!parts.success) throw new SocialRouteError("invalid_request");
  const [[, file]] = parts.data;
  if (file.size > SALE_COVER_MAX_BYTES) throw new SocialRouteError("body_too_large");
  const declared = file.type ? file.type.split(";", 1)[0]!.trim().toLowerCase() : null;
  return { bytes: new Uint8Array(await file.arrayBuffer()), declared };
}
