import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialPublicPortfolioRoute } from "@blast/server/modules/social/portfolio/public-route.ts";

/**
 * The public portfolio read (OA-10) runs on the read replica
 * (`blast_replica`), like the profile it belongs to; the owner's own
 * portfolio stays on the primary (`runtime.ts`). The replica pool fails
 * closed without `DATABASE_REPLICA_URL` (`service_unavailable`).
 */
export function socialPublicPortfolioDatabase(): ReadableDatabase {
  return autocommitReader(replicaPool(), "social", { label: "social.public_portfolio", prepare: true });
}

/** The process's `GET /api/social/profiles/{callsign}/portfolio` handler over the shared social kit. */
export function socialPublicPortfolioRoute(): ReturnType<typeof createSocialPublicPortfolioRoute> {
  return processSingleton("social.public-portfolio-route", () =>
    createSocialPublicPortfolioRoute({
      kit: sharedSocialRouteKit(),
      database: socialPublicPortfolioDatabase,
    }));
}
