import { CREATE_LOGO_MAX_BYTES, CREATE_LOGO_MIN_SIDE, CREATE_LOGO_SIDE, CREATE_LOGO_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import type { SquareImageLimits } from "@blast/server/modules/social/square-image.ts";

/**
 * A Create coin logo (`square-image.ts`): PNG, JPEG or WebP up to 2 MiB, a
 * still image from 64 to 4,096 pixels a side, stored as a 512 px WebP under
 * `create-logos/` (SVG is refused: a coin icon is shown by every wallet and
 * explorer, so only re-encoded pixels are served).
 */
export const CREATE_LOGO_IMAGE: SquareImageLimits = Object.freeze({
  types: CREATE_LOGO_TYPES,
  maxBytes: CREATE_LOGO_MAX_BYTES,
  minSide: CREATE_LOGO_MIN_SIDE,
  maxSide: 4_096,
  side: CREATE_LOGO_SIDE,
  quality: 88,
});

/** Where logos live in the public launch-asset store. */
export const CREATE_LOGO_FOLDER = "create-logos";
