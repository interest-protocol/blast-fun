import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { socialFeedDatabase } from "@blast/server/modules/social/feed/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialPostRoutes } from "@blast/server/modules/social/posts/route.ts";

/**
 * The item routes over the shared social kit: the public item read on the
 * replica (as the feed), reactions written on the primary.
 */
export function socialPostRoutes(): ReturnType<typeof createSocialPostRoutes> {
  return processSingleton("social.post-routes", () =>
    createSocialPostRoutes({
      kit: sharedSocialRouteKit(),
      database: socialFeedDatabase,
      config: getSocialConfig,
    }));
}
