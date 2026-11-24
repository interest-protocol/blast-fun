import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialSearchRoutes } from "@blast/server/modules/social/search/route.ts";

/**
 * Search reads on the read replica (`blast_replica`), never the primary;
 * without `DATABASE_REPLICA_URL` the route answers `service_unavailable`.
 */
export function socialSearchDatabase(): ReadableDatabase {
  return autocommitReader(replicaPool(), "social", { label: "social.search" });
}

export function socialSearchRoutes(): ReturnType<typeof createSocialSearchRoutes> {
  return processSingleton("social.search-routes", () =>
    createSocialSearchRoutes({ kit: sharedSocialRouteKit(), database: socialSearchDatabase }));
}
