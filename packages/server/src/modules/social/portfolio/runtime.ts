
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { walletVestings } from "@blast/server/modules/vesting/read.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialPortfolioRoute } from "@blast/server/modules/social/portfolio/route.ts";

/**
 * Every portfolio read (the account's wallets, `chain_read_v1` prices and
 * positions, attribution totals) runs on the primary pool
 * (`primaryPool`), never the replica: an owner sees what they just did.
 */
export function socialPortfolioDatabase(): ReadableDatabase {
  return autocommitReader(primaryPool(), "social", { label: "social.portfolio", prepare: true });
}

/** The process's `GET /api/social/me/portfolio` handler over the shared social kit. */
export function socialPortfolioRoute(): ReturnType<typeof createSocialPortfolioRoute> {
  return processSingleton("social.portfolio-route", () =>
    createSocialPortfolioRoute({
      kit: sharedSocialRouteKit(),
      wallets: socialAccounts(),
      database: socialPortfolioDatabase,
      walletVestings: async (caller) => {
        const wallet = await blastWalletOf(caller);
        return wallet ? walletVestings(wallet) : [];
      },
    }));
}
