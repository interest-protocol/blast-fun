import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { socialFeedDatabase } from "@blast/server/modules/social/feed/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialActivityRoute } from "@blast/server/modules/social/activity/route.ts";

/** The process's `GET /api/social/activity` handler: on the replica, like the feed and the tape. */
export function socialActivityRoute(): ReturnType<typeof createSocialActivityRoute> {
  return processSingleton("social.activity-route", () =>
    createSocialActivityRoute({
      kit: sharedSocialRouteKit(),
      database: socialFeedDatabase,
    }));
}
