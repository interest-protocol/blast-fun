import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialTransactionsRoute, type SocialTransactionsRoute } from "@blast/server/modules/social/transactions/route.ts";

/** The log is read on the primary pool (`primaryPool`), never the replica: personal data, read right after it is written. */
export function socialTransactionsDatabase(): ReadableDatabase {
  return autocommitReader(primaryPool(), "social", { label: "social.transactions" });
}

/** The process's `GET /api/social/me/transactions` handler over the shared social kit. */
export function socialTransactionsRoute(): SocialTransactionsRoute {
  return processSingleton("social.transactions-route", () =>
    createSocialTransactionsRoute({ kit: sharedSocialRouteKit(), database: socialTransactionsDatabase }));
}
