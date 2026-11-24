import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { presaleDeploymentGate, presaleSigningIdentity } from "@blast/server/modules/presale/deployment/runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";

import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createClaimChain, type ClaimChain } from "@blast/server/modules/social/claims/chain.ts";
import { createSocialClaimRoutes, type SocialClaimRoutes } from "@blast/server/modules/social/claims/route.ts";

/**
 * The production claim route: the shared social kit, the primary, the
 * presale deployment gate (claiming is off unless the deployment is a
 * **mainnet** package, exactly as committing is), the process's mainnet node
 * for the chain reads (`RuntimeConfig.suiNodeUrl`), and the Blast wallet resolver the coins sheet
 * uses. The chain client is built once, after the gate first authorizes.
 */
export function socialClaimRoutes(): SocialClaimRoutes {
  return processSingleton("social.claim-routes", () => {
    let reads: ClaimChain | undefined;
    return createSocialClaimRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.claim" }),
      async deployment(signal) {
        const gate = presaleDeploymentGate();
        if (mainnetIdentity(gate.state) === null) return null;
        return presaleSigningIdentity(gate, { signal });
      },
      chain(identity: PresaleRuntimeIdentity) {
        if (reads) return reads;
        const gate = presaleDeploymentGate();
        const baseUrl = presaleNodeUrl(gate.state, runtimeConfig().suiNodeUrl);
        if (!baseUrl) throw new Error("The presale node is not configured.");
        reads = createClaimChain({ client: new SuiGrpcClient({ network: "mainnet", baseUrl, format: "text", fetch: boundedFetch(8_000) }), identity });
        return reads;
      },
      blastWallet: blastWalletOf,
    });
  });
}
