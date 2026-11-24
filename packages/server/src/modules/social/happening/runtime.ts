import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { socialFeedDatabase } from "@blast/server/modules/social/feed/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialHappeningRoute } from "@blast/server/modules/social/happening/route.ts";

/** The process's `GET /api/social/happening` handler: on the replica, like the feed. */
export function socialHappeningRoute(): ReturnType<typeof createSocialHappeningRoute> {
  return processSingleton("social.happening-route", () =>
    createSocialHappeningRoute({
      kit: sharedSocialRouteKit(),
      database: socialFeedDatabase,
      config: getSocialConfig,
    }));
}
