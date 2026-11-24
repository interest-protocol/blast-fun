import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { findBlockedTerm, getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialWhyRoutes } from "@blast/server/modules/social/whys/route.ts";

/** The why routes over the shared social kit, written on the primary. */
export function socialWhyRoutes(): ReturnType<typeof createSocialWhyRoutes> {
  return processSingleton("social.why-routes", () =>
    createSocialWhyRoutes({
      kit: sharedSocialRouteKit(),
      config: getSocialConfig,
      findBlockedTerm,
    }));
}
