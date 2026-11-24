// The launch image policy both the browser and the upload route apply. Only
// these raster formats, sizes, and dimensions can become a launch's official
// image; everything else is refused before it is stored.

export const LAUNCH_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type LaunchImageType = (typeof LAUNCH_IMAGE_TYPES)[number];

/**
 * Largest accepted upload. The protected-write body is at most 64 KiB, and a
 * Wallet Proof may take about 10 KiB of it, so 36 KiB of image (48 KiB as
 * base64) always fits.
 */
export const LAUNCH_IMAGE_MAX_BYTES = 36 * 1_024;
/**
 * Largest re-encoded image the route stores. Re-encoding a compressed upload
 * can grow it severalfold, so this leaves headroom over the upload limit.
 */
export const LAUNCH_IMAGE_STORED_MAX_BYTES = 256 * 1_024;
export const LAUNCH_IMAGE_MIN_SIDE = 64;
export const LAUNCH_IMAGE_MAX_SIDE = 1_024;

export type LaunchImageRejection =
  | "unsupported-type"
  | "type-mismatch"
  | "too-large"
  | "active-content"
  | "undecodable"
  | "animated"
  | "dimensions";

/** Whether decoded dimensions are within the policy. */
export function launchImageSidesAllowed(
  width: number,
  height: number,
): boolean {
  const within = (side: number) =>
    side >= LAUNCH_IMAGE_MIN_SIDE && side <= LAUNCH_IMAGE_MAX_SIDE;
  return within(width) && within(height);
}

const ACTIVE_CONTENT =
  /<\s*(script|svg|html|iframe|object|embed)\b|<!doctype|<\?xml|javascript:/i;

function detectType(bytes: Uint8Array): LaunchImageType | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "image/webp";
  return null;
}

/**
 * The checks that need no decoder: the declared type is allowed, the bytes
 * are within the size limit, their signature is that type, and they carry no
 * markup or script that a browser could run.
 */
export function sniffLaunchImage(
  bytes: Uint8Array,
  declared: string,
):
  | Readonly<{ ok: true; contentType: LaunchImageType }>
  | Readonly<{ ok: false; reason: LaunchImageRejection }> {
  if (!(LAUNCH_IMAGE_TYPES as readonly string[]).includes(declared))
    return { ok: false, reason: "unsupported-type" };
  if (bytes.length > LAUNCH_IMAGE_MAX_BYTES)
    return { ok: false, reason: "too-large" };
  if (bytes.length === 0) return { ok: false, reason: "undecodable" };
  if (detectType(bytes) !== declared)
    return { ok: false, reason: "type-mismatch" };
  let text = "";
  for (let start = 0; start < bytes.length; start += 8_192) {
    text += String.fromCharCode(...bytes.subarray(start, start + 8_192));
  }
  if (ACTIVE_CONTENT.test(text)) return { ok: false, reason: "active-content" };
  return { ok: true, contentType: declared as LaunchImageType };
}
