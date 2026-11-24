import { socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_ACTIVITY_ROUTE } from "@blast/core/modules/social/contracts/activity.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { decodeActivityCursor, readActivityPage, type ActivityCursor } from "@blast/server/modules/social/activity/read.ts";

export type SocialActivityRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production (`socialFeedDatabase`). Resolved per request. */
  database: () => ReadableDatabase;
  now?: () => number;
}>;

/** `before`, at most once; any other parameter is ignored. */
export function parseActivityQuery(url: URL): ActivityCursor | null {
  const value = socialSingle(url.searchParams, "before");
  return value === null ? null : decodeActivityCursor(value);
}

/**
 * `GET /api/social/activity` (contract in `contracts/activity.ts`): public,
 * no authentication (no token or cookie is read), bucket `social_read`, a 200
 * publicly cached (`SOCIAL_PUBLIC_CACHE_CONTROL`); errors are `no-store`.
 */
export function createSocialActivityRoute(dependencies: SocialActivityRouteDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_ACTIVITY_ROUTE, auth: "none", bucket: "social_read", cache: "public" },
      async (context) => {
        const before = parseActivityQuery(new URL(context.request.url));
        return context.json(await readActivityPage(database(), { nowMs: now(), before, hiddenKinds: context.hiddenKinds }));
      },
    ),
  });
}
