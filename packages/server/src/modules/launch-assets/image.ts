import {
  LAUNCH_IMAGE_MAX_SIDE,
  LAUNCH_IMAGE_STORED_MAX_BYTES,
  launchImageSidesAllowed,
  sniffLaunchImage,
  type LaunchImageRejection,
  type LaunchImageType,
} from "@blast/core/lib/launchpad/launch-image.ts";

export type SanitizedLaunchImage = Readonly<{
  bytes: Buffer;
  contentType: LaunchImageType;
  width: number;
  height: number;
}>;

export type LaunchImageResult =
  | Readonly<{ ok: true; image: SanitizedLaunchImage }>
  | Readonly<{ ok: false; reason: LaunchImageRejection }>;

const FORMATS: Readonly<Record<LaunchImageType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

/**
 * Decodes an upload and writes a fresh raster in the same format: EXIF,
 * ICC, text chunks, and any bytes outside the image are dropped, and the
 * orientation is applied to the pixels. Anything the decoder refuses, any
 * animation, and any size outside the policy is rejected.
 */
export async function sanitizeLaunchImage(
  bytes: Uint8Array,
  declared: string,
): Promise<LaunchImageResult> {
  const sniffed = sniffLaunchImage(bytes, declared);
  if (!sniffed.ok) return sniffed;
  const { default: sharp } = await import("sharp");
  const input = Buffer.from(bytes);
  const options = {
    failOn: "error" as const,
    limitInputPixels: LAUNCH_IMAGE_MAX_SIDE * LAUNCH_IMAGE_MAX_SIDE,
    animated: true,
  };
  let metadata;
  try {
    metadata = await sharp(input, options).metadata();
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  if (metadata.format !== FORMATS[sniffed.contentType])
    return { ok: false, reason: "type-mismatch" };
  if ((metadata.pages ?? 1) > 1) return { ok: false, reason: "animated" };
  const { width = 0, height = 0 } = metadata;
  if (!launchImageSidesAllowed(width, height))
    return { ok: false, reason: "dimensions" };
  let output: { data: Buffer; info: { width: number; height: number } };
  try {
    const image = sharp(input, {
      failOn: "error",
      limitInputPixels: options.limitInputPixels,
    }).rotate();
    const encoded =
      sniffed.contentType === "image/png"
        ? image.png({ compressionLevel: 9 })
        : sniffed.contentType === "image/jpeg"
          ? image.jpeg({ quality: 90, mozjpeg: true })
          : image.webp({ quality: 90 });
    output = await encoded.toBuffer({ resolveWithObject: true });
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  if (output.data.length > LAUNCH_IMAGE_STORED_MAX_BYTES)
    return { ok: false, reason: "too-large" };
  return {
    ok: true,
    image: {
      bytes: output.data,
      contentType: sniffed.contentType,
      width: output.info.width,
      height: output.info.height,
    },
  };
}
