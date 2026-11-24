import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { readLaunchRewards } from "@blast/core/modules/launchpad-contract/rewards.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { configuredLaunchReadChain } from "@blast/server/modules/launchpad-coin/chain.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { blastWalletOf } from "../coins/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createLaunchClaimChain, type LaunchClaimChain } from "./chain.ts";
import { createLaunchClaimRoutes, type LaunchClaimRoutes } from "./route.ts";

/**
 * The production launch claim route: the shared social kit, the primary, the released Blast
 * deployment on `BLAST_NETWORK` and its fullnode (claiming is off while none is released, as the
 * coin page's signing is), the presale sponsor for every caller's wallet, and the Blast wallet
 * resolver the coins sheet uses. A vault claim's vault is blast-infra's (`/v1/launches/{id}/rewards`),
 * which the chain then confirms. The chain reads are built once.
 */
export function launchClaimRoutes(): LaunchClaimRoutes {
  return processSingleton("social.launch-claim-routes", () => {
    let reads: Promise<LaunchClaimChain | null> | undefined;
    return createLaunchClaimRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.launch_claim" }),
      chain() {
        reads ??= configuredLaunchReadChain().then((configured) => configured && createLaunchClaimChain(configured));
        return reads;
      },
      blastWallet: blastWalletOf,
      sponsor: (request) => sponsorService().sponsor({ ...request, intent: "launch_claim", presaleId: null }),
      async vaultOf(launchId) {
        const read = await readLaunchRewards(launchId, defaultMarketDataDependencies());
        if (read.status === "unavailable") throw new Error(`blast-infra is unavailable: ${read.provenance.reason ?? "unknown"}`);
        return read.data.kind === "answer" ? (read.data.value.vault?.vaultId ?? null) : null;
      },
    });
  });
}
