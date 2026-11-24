import { PRESALE_PAUSE_BITS } from "@interest-protocol/blast-sdk/presale";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { presaleDeploymentGate, presaleSigningIdentity } from "@blast/server/modules/presale/deployment/runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { socialTradeChain, socialTradeDatabase, socialTradeQuoteKey, socialTradeRouter } from "@blast/server/modules/social/trades/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { createCommitChain, type CommitChain } from "@blast/server/modules/social/commit/chain.ts";
import { createSocialCommitRoutes, type SocialCommitRoutes } from "@blast/server/modules/social/commit/route.ts";

/**
 * The production commit route: the shared social kit, the presale deployment
 * gate (committing is off unless the deployment is a **mainnet** package),
 * the process's mainnet node for the chain reads and the build
 * (`RuntimeConfig.suiNodeUrl`), and the
 * Blast wallet resolver the coins sheet and the claim use. The chain client is
 * built once, after the gate first authorizes. The claim's runtime is the
 * pattern (`claims/runtime.ts`).
 */
export function socialCommitRoutes(): SocialCommitRoutes {
  return processSingleton("social.commit-routes", () => {
    let reads: CommitChain | undefined;
    return createSocialCommitRoutes({
      kit: sharedSocialRouteKit(),
      async deployment(signal) {
        const gate = presaleDeploymentGate();
        if (mainnetIdentity(gate.state) === null) return null;
        return presaleSigningIdentity(gate, { signal, presalePauseBit: PRESALE_PAUSE_BITS.Commit });
      },
      chain(identity: PresaleRuntimeIdentity) {
        if (reads) return reads;
        const gate = presaleDeploymentGate();
        const baseUrl = presaleNodeUrl(gate.state, runtimeConfig().suiNodeUrl);
        if (!baseUrl) throw new Error("The presale node is not configured.");
        reads = createCommitChain({ client: new SuiGrpcClient({ network: "mainnet", baseUrl, format: "text", fetch: boundedFetch(8_000) }), identity });
        return reads;
      },
      blastWallet: blastWalletOf,
      swap: { database: socialTradeDatabase, router: () => socialTradeRouter(), chain: socialTradeChain, quoteKey: () => socialTradeQuoteKey() },
      sponsor: sponsorService,
    });
  });
}
