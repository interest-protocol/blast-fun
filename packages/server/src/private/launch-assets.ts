import { runtimeConfig } from "../config/runtime-config.ts";
import { launchAssetHandler, launchAssetStore } from "../modules/launch-assets/index.ts";
import { withLaunchpadRuntime } from "../modules/launchpad-identity/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** The signed transport delegates unchanged credential, CSRF and image policy. */
export const LAUNCH_ASSET_HANDLERS = {
  "launch.assets.create": (request, { client }) =>
    withLaunchpadRuntime((launchpad) =>
      launchAssetHandler(launchAssetStore(runtimeConfig().launchAssetBlobToken), launchpad)(request, client),
    ),
} satisfies PrivateHandlers;
