import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { createSocialPresaleRuntimeRoutes as createPublicRoutes } from "@blast/server/modules/social/presales/shared-runtime.ts";

/** Private viewer reads retain their existing wallet resolver. */
export function createSocialPresaleRuntimeRoutes(kit: SocialRouteKit) {
  return createPublicRoutes(kit, blastWalletOf);
}

export function socialPresaleRoutes() {
  return processSingleton("social.presale-viewer-routes", () =>
    createSocialPresaleRuntimeRoutes(sharedSocialRouteKit()),
  );
}
