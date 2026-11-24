import { primaryPool } from "@blast/core/modules/database/pool.ts";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { presaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/runtime.ts";
import { sharedSocialRouteKit, socialMainnetClient } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import type { SocialCaller } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialCoinsRoutes, type SocialCoinsRoutes, type TransferLookup } from "@blast/server/modules/social/coins/route.ts";
import type { CoinsFullnode } from "@blast/server/modules/social/coins/wallet.ts";

/** The mainnet node with the app's Sui client configuration (`socialMainnetClient`), one per process. */
function mainnet(): SuiGrpcClient {
  return socialMainnetClient("social.coins-fullnode");
}

/**
 * An executed transaction as the settlement reads it, or null while the
 * fullnode does not have it (not found yet, or not reachable).
 */
export function fullnodeTransferLookup(client: () => Pick<SuiGrpcClient, "core">): TransferLookup {
  return {
    async executed(digest, signal) {
      const result = await client().core.getTransaction({ digest, include: { balanceChanges: true, transaction: true }, signal });
      const transaction = result.Transaction ?? result.FailedTransaction;
      const sender = transaction?.transaction?.sender;
      if (!transaction || transaction.digest !== digest || typeof sender !== "string") return null;
      return { success: transaction.status.success, sender, balanceChanges: transaction.balanceChanges ?? [] };
    },
  };
}

/**
 * The caller's Blast wallet: a Privy session's embedded Sui wallet through
 * the presale's resolver (its Postgres cache, then Privy's users API), or a
 * wallet session's own address (OA-16).
 */
export function blastWalletOf(caller: SocialCaller): Promise<string | null> {
  return caller.kind === "privy" ? presaleEmbeddedWallets().find(caller.did) : Promise.resolve(caller.address);
}

/** The production coins routes over the shared social kit, the primary and the mainnet fullnode. */
export function socialCoinsRoutes(): SocialCoinsRoutes {
  return processSingleton("social.coins-routes", () =>
    createSocialCoinsRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.coins" }),
      fullnode: (): CoinsFullnode => mainnet().core,
      transactions: () => fullnodeTransferLookup(mainnet),
      blastWallet: blastWalletOf,
    }));
}
