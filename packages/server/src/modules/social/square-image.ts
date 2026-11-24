import { createHash } from "node:crypto";

import type { LaunchAssetStore } from "@blast/server/modules/launch-assets/store.ts";

/**
 * The social uploads that become a square picture in the public launch-asset
 * store (the profile picture, a Create coin logo), or a wide one (a sale's
 * cover, R3-24): one pipeline, each use with its own limits. The bytes must
 * be the declared PNG, JPEG or WebP, the decoder must accept them, and they
 * must be a still image within the side limits; the orientation is applied,
 * the centre of the stored shape is kept, and a fresh WebP without any
 * metadata block (EXIF, ICC, XMP, text) is written, so nothing but pixels is
 * ever served back. SVG is never accepted.
 */

export const SQUARE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type SquareImageType = (typeof SQUARE_IMAGE_TYPES)[number];

/** Why an upload was refused (the `reason` of `invalid_image` / `invalid_logo`). */
export type SquareImageRejection = "type" | "undecodable" | "animated" | "dimensions";

export type SquareImageLimits = Readonly<{
  /** The types this use accepts (a subset of `SQUARE_IMAGE_TYPES`). */
  types: readonly string[];
  maxBytes: number;
  minSide: number;
  /** The largest side the input may decode to (bounds the decoding work). */
  maxSide: number;
  /** The stored square's side in pixels (the stored image's width when `height` is set). */
  side: number;
  /** A wide image's stored height (a sale cover is 1536 × 512); absent for a square. */
  height?: number;
  /** WebP quality of the stored square. */
  quality: number;
}>;

export type SquareImageResult =
  /** `source`: the upload's size as shown, after its EXIF orientation (which `rotate()` applies). */
  | Readonly<{ ok: true; bytes: Buffer; contentType: "image/webp"; source: Readonly<{ width: number; height: number }> }>
  | Readonly<{ ok: false; reason: SquareImageRejection }>;

const FORMATS: Readonly<Record<SquareImageType, string>> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

/** The image type the bytes' signature says, or null. */
export function sniffSquareImageType(bytes: Uint8Array): SquareImageType | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Decodes an upload under `limits` and writes the stored square, or says why it was refused. */
export async function sanitizeSquareImage(bytes: Uint8Array, declared: string | null, limits: SquareImageLimits): Promise<SquareImageResult> {
  const type = limits.types.includes(declared ?? "") && Object.hasOwn(FORMATS, declared ?? "") ? (declared as SquareImageType) : null;
  if (!type || bytes.length === 0 || bytes.length > limits.maxBytes || sniffSquareImageType(bytes) !== type) return { ok: false, reason: "type" };
  const { default: sharp } = await import("sharp");
  const input = Buffer.from(bytes);
  const limitInputPixels = limits.maxSide * limits.maxSide;
  let metadata;
  try {
    metadata = await sharp(input, { failOn: "error", limitInputPixels, animated: true }).metadata();
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  if (metadata.format !== FORMATS[type]) return { ok: false, reason: "type" };
  if ((metadata.pages ?? 1) > 1) return { ok: false, reason: "animated" };
  const { width = 0, height = 0 } = metadata;
  const within = (side: number) => side >= limits.minSide && side <= limits.maxSide;
  if (!within(width) || !within(height)) return { ok: false, reason: "dimensions" };
  try {
    const output = await sharp(input, { failOn: "error", limitInputPixels })
      .rotate()
      .resize(limits.side, limits.height ?? limits.side, { fit: "cover", position: "centre" })
      .webp({ quality: limits.quality })
      .toBuffer();
    // EXIF orientations 5 to 8 turn the picture a quarter: its shown width is the decoded height.
    const turned = (metadata.orientation ?? 1) >= 5;
    return { ok: true, bytes: output, contentType: "image/webp", source: turned ? { width: height, height: width } : { width, height } };
  } catch {
    return { ok: false, reason: "undecodable" };
  }
}

/**
 * Writes a sanitized square to the public store at `<folder>/<sha256>.webp`
 * (its content address: the same picture stored twice is one object) and
 * answers its https URL, or null when the store failed or answered anything
 * else (the caller's `…_upload_unavailable`).
 */
export async function storeSquareImage(
  store: Pick<LaunchAssetStore, "write">,
  folder: string,
  image: Readonly<{ bytes: Buffer; contentType: "image/webp" }>,
): Promise<string | null> {
  let url: string;
  try {
    url = (await store.write(squareImagePath(folder, createHash("sha256").update(image.bytes).digest("hex")), image.bytes, image.contentType)).url;
  } catch {
    return null;
  }
  return /^https:\/\/[^\s]{1,2040}$/.test(url) ? url : null;
}

/** A stored square's path in the public store: its content address under `folder`. */
export function squareImagePath(folder: string, sha256: string): string {
  return `${folder}/${sha256}.webp`;
}
