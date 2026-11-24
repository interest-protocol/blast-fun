import { PROFILE_PICTURE_MAX_BYTES, PROFILE_PICTURE_MIN_SIDE, PROFILE_PICTURE_SIDE, PROFILE_PICTURE_TYPES } from "@blast/core/modules/social/contracts/profile-page.ts";
import type { SquareImageLimits } from "@blast/server/modules/social/square-image.ts";

/**
 * A profile picture (`square-image.ts`): PNG, JPEG or WebP up to 2 MiB, a
 * still image from 64 to 4,096 pixels a side, stored as a 400 px WebP.
 */
export const PROFILE_PICTURE_IMAGE: SquareImageLimits = Object.freeze({
  types: PROFILE_PICTURE_TYPES,
  maxBytes: PROFILE_PICTURE_MAX_BYTES,
  minSide: PROFILE_PICTURE_MIN_SIDE,
  maxSide: 4_096,
  side: PROFILE_PICTURE_SIDE,
  quality: 86,
});
