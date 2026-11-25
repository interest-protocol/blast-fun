import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_NEW_ROUTE, SOCIAL_FEED_ROUTE, type SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import { ITEM_PAGE_DEFAULT_LIMIT } from "@blast/core/modules/social/contracts/items.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createForYouNewReader, parseFeedNewRequest, parseFeedRequest, readForYouPage } from "@blast/server/modules/social/feed/feed-reader.ts";
import { createReadCache } from "@blast/server/modules/social/read-cache.ts";

const FEED_FRESH_SECONDS = 10;

export type SocialFeedRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The service-owned replica reader, independent of any individual request. */
  database: () => ReadableDatabase;
  /** The tuning values of this read (`getSocialConfig`). */
  config: () => Promise<SocialConfig>;
  now?: () => number;
}>;

/**
 * `GET /api/social/feed?tab=for_you&cursor=&limit=`: the public For You
 * page. No authentication, and the Authorization header is never read, so a
 * token changes nothing; bucket `social_read` (IP). The default first page
 * shares its public freshness budget between the origin and the CDN.
 */
export function createSocialFeedRoute(dependencies: SocialFeedRouteDependencies) {
  const { kit, database, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  const readNew = createForYouNewReader(database, now);
  const firstPage = createReadCache<SocialFeedPage>(FEED_FRESH_SECONDS * 1000, 8, now);
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_FEED_ROUTE, auth: "none", bucket: "social_read", cache: "public" },
      async (context) => {
        const request = parseFeedRequest(new URL(context.request.url).searchParams);
        const tuning = await config();
        const load = () => readForYouPage(database(), {
          config: tuning,
          nowMs: now(),
          limit: request.limit,
          before: request.before,
          hiddenKinds: context.hiddenKinds,
        });
        if (request.before !== null || request.limit !== ITEM_PAGE_DEFAULT_LIMIT) return context.json(await load());

        const key = JSON.stringify([request.tab, context.hiddenKinds, tuning]);
        let ageMs = 0;
        const page = await firstPage.read(key, load, (age) => { ageMs = age; });
        const response = context.json(page);
        const remaining = Math.floor(FEED_FRESH_SECONDS - ageMs / 1000);
        response.headers.set("cache-control", remaining > 0 ? `public, s-maxage=${remaining}, stale-while-revalidate=20` : "no-store");
        return response;
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
