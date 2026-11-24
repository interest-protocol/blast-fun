import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialFollowRoutes } from "@blast/server/modules/social/follows/route.ts";

/** The process's follow handlers over the shared social kit: every read and write on the primary. */
export function socialFollowRoutes(): ReturnType<typeof createSocialFollowRoutes> {
  return processSingleton("social.follow-routes", () => createSocialFollowRoutes({ kit: sharedSocialRouteKit() }));
}
