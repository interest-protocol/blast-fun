import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { readPresaleTerms } from "@blast/server/modules/social/presales/shared-runtime.ts";
import { createSocialWatchlistRoutes } from "@blast/server/modules/social/watchlist/route.ts";

/** The watchlist reads on the primary: an account reads its own stars right after writing them. */
export function socialWatchlistDatabase(): ReadableDatabase {
  return autocommitReader(primaryPool(), "social", { label: "social.watchlist" });
}

export function socialWatchlistRoutes(): ReturnType<typeof createSocialWatchlistRoutes> {
  return processSingleton("social.watchlist-routes", () =>
    createSocialWatchlistRoutes({ kit: sharedSocialRouteKit(), database: socialWatchlistDatabase, terms: readPresaleTerms }));
}
