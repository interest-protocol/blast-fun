import type { Pool } from "pg";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { getSocialConfig } from "@blast/core/modules/social/config/reader.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { socialProfileViewerDatabase } from "@blast/server/modules/social/profiles/member-account.ts";
import { createSocialProfileRoutes } from "@blast/server/modules/social/profiles/route.ts";

/**
 * Profile reads run on the read replica (`blast_replica`), never the
 * primary. The replica pool fails closed without `DATABASE_REPLICA_URL`; the
 * routes then answer `service_unavailable`. Tuning values come from
 * `getSocialConfig()` (the primary, cached for 30 s), as the feed's do.
 */
export function socialProfilePool(): Pool {
  return replicaPool();
}

/** Profile reads as standalone autocommit reads on the replica. */
export function socialProfileDatabase(): ReadableDatabase {
  return autocommitReader(socialProfilePool(), "social", { label: "social.profile" });
}

/** The process's profile handlers over the shared social kit. */
export function socialProfileRoutes(): ReturnType<typeof createSocialProfileRoutes> {
  return processSingleton("social.profile-routes", () =>
    createSocialProfileRoutes({
      kit: sharedSocialRouteKit(),
      database: socialProfileDatabase,
      config: getSocialConfig,
      primary: socialProfileViewerDatabase,
    }));
}
