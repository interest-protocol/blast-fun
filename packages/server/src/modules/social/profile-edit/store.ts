import type { LaunchAssetStore } from "@blast/server/modules/launch-assets/store.ts";

/**
 * Where uploaded profile pictures live: the app's public blob store (the one
 * launch images use, `LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`), under
 * `social-pictures/<sha256>.webp`. A picture's path is its content address,
 * so storing the same picture twice keeps one object; a replaced picture's
 * object stays (another account may show the same bytes). Without a token
 * uploads are off: the edit sheet then offers the X picture and the
 * generated avatar only, and the upload route answers
 * `picture_upload_unavailable`.
 */
export type ProfilePictureStore = Pick<LaunchAssetStore, "write">;

/** Where pictures live in the public store (`square-image.ts` content addresses). */
export const PROFILE_PICTURE_FOLDER = "social-pictures";
