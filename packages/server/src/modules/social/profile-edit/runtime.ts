import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { findBlockedTerm } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialProfileEditRoutes } from "@blast/server/modules/social/profile-edit/route.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { launchAssetStore } from "@blast/server/modules/launch-assets/store.ts";

/** The process's edit-sheet handlers over the shared social kit, the cached blocked terms and the public blob store. */
export function socialProfileEditRoutes(): ReturnType<typeof createSocialProfileEditRoutes> {
  return processSingleton("social.profile-edit-routes", () => {
    const store = launchAssetStore(runtimeConfig().launchAssetBlobToken);
    return createSocialProfileEditRoutes({ kit: sharedSocialRouteKit(), findBlockedTerm, store: () => store });
  });
}
