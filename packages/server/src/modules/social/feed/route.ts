import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_NEW_ROUTE, SOCIAL_FEED_ROUTE } from "@blast/core/modules/social/contracts/feed.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createForYouNewReader, parseFeedNewRequest, parseFeedRequest, readForYouPage } from "@blast/server/modules/social/feed/feed-reader.ts";

export type SocialFeedRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production (`socialFeedDatabase`). Resolved per request. */
  database: () => ReadableDatabase;
  /** The tuning values of this read (`getSocialConfig`). */
  config: () => Promise<SocialConfig>;
  now?: () => number;
}>;

/**
 * `GET /api/social/feed?tab=for_you&cursor=&limit=`: the public For You
 * page. No authentication, and the Authorization header is never read, so a
 * token changes nothing; bucket `social_read` (IP). A 200 is publicly cached
 * (`SOCIAL_PUBLIC_CACHE_CONTROL`); errors are `no-store`.
 */
export function createSocialFeedRoute(dependencies: SocialFeedRouteDependencies) {
  const { kit, database, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  const readNew = createForYouNewReader(database, now);
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_FEED_ROUTE, auth: "none", bucket: "social_read", cache: "public" },
      async (context) => {
        const request = parseFeedRequest(new URL(context.request.url).searchParams);
        const page = await readForYouPage(database(), {
          config: await config(),
          nowMs: now(),
          limit: request.limit,
          before: request.before,
          hiddenKinds: context.hiddenKinds,
        });
        return context.json(page);
      },
    ),
    /**
     * `GET /api/social/feed/new?since=<ms>`: the "N new posts" count, public
     * and cached like the page (contract in `contracts/feed.ts`).
     */
    NEW: kit.route(
      { name: SOCIAL_FEED_NEW_ROUTE, auth: "none", bucket: "social_read", cache: "public" },
      async (context) => {
        const { sinceMs } = parseFeedNewRequest(new URL(context.request.url).searchParams);
        return context.json(await readNew({
          config: await config(),
          sinceMs,
          hiddenKinds: context.hiddenKinds,
        }));
      },
    ),
  });
}
