import type { Pool } from "pg";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialFeedRoute } from "@blast/server/modules/social/feed/route.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";

/**
 * Feed reads run on the read replica (`blast_replica`), never the primary.
 * The replica pool fails closed without `DATABASE_REPLICA_URL`; the route
 * then answers `service_unavailable`. Tuning values come from
 * `getSocialConfig()` (the primary, cached for 30 s).
 */
export function socialFeedPool(): Pool {
  return replicaPool();
}

/** Feed reads as standalone autocommit reads on the replica. */
export function socialFeedDatabase(): ReadableDatabase {
  return autocommitReader(socialFeedPool(), "social", { label: "social.feed" });
}

/** The process's `GET /api/social/feed` and `GET /api/social/feed/new` handlers over the shared social kit. */
export function socialFeedRoute(): ReturnType<typeof createSocialFeedRoute> {
  return processSingleton("social.feed-route", () =>
    createSocialFeedRoute({
      kit: sharedSocialRouteKit(),
      database: socialFeedDatabase,
      config: getSocialConfig,
      shared: publicReadCache("social"),
    }));
}
