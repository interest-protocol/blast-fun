import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_HAPPENING_ROUTE } from "@blast/core/modules/social/contracts/happening.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createHappeningReader } from "@blast/server/modules/social/happening/read.ts";

export type SocialHappeningRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production (`socialFeedDatabase`). Resolved per shared read, never a request transaction or signal. */
  database: () => ReadableDatabase;
  config: () => Promise<SocialConfig>;
  now?: () => number;
}>;

/**
 * `GET /api/social/happening` (contract in `contracts/happening.ts`): public,
 * no authentication (no token or cookie is read), bucket `social_read`, a 200
 * publicly cached (`SOCIAL_PUBLIC_CACHE_CONTROL`); errors are `no-store`.
 * Query parameters are ignored, so every URL variant is the same answer.
 */
export function createSocialHappeningRoute(dependencies: SocialHappeningRouteDependencies) {
  const { kit, database, config } = dependencies;
  const read = createHappeningReader(database, dependencies.now ?? Date.now);
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_HAPPENING_ROUTE, auth: "none", bucket: "social_read", cache: "public" },
      async (context) =>
        context.json(await read({ config: await config(), hiddenKinds: context.hiddenKinds })),
    ),
  });
}
