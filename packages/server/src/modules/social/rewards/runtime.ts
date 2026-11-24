import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { autocommitReader, withTransaction, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { waitingRewardsFor } from "@blast/core/modules/presale/rewards/waiting.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialRewardsRoute, type SocialRewardsRoute } from "@blast/server/modules/social/rewards/route.ts";

/** Rewards are read on the primary pool (`primaryPool`), never the replica: personal data, as the portfolio. */
export function socialRewardsDatabase(): ReadableDatabase {
  return autocommitReader(primaryPool(), "social", { label: "social.rewards" });
}

/**
 * The process's `GET /api/social/me/rewards` handler over the shared social
 * kit. `waiting` is the reward relay's reader (`presale/rewards/waiting.ts`
 * `waitingRewardsFor`) on the same primary, for the deployment's network
 * (`RuntimeConfig.expectedDeployment`).
 */
export function socialRewardsRoute(): SocialRewardsRoute {
  return processSingleton("social.rewards-route", () => {
    const { network } = runtimeConfig().expectedDeployment;
    return createSocialRewardsRoute({
      kit: sharedSocialRouteKit(),
      wallets: socialAccounts(),
      database: socialRewardsDatabase,
      network,
      waiting: () => (wallets) => withTransaction(
        primaryPool(),
        (tx) => waitingRewardsFor(tx, network, wallets),
        { isolationLevel: "REPEATABLE READ", label: "social.rewards.waiting" },
      ),
    });
  });
}
