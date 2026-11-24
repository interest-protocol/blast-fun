import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { presaleDeploymentGate } from "@blast/server/modules/presale/deployment/runtime.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";

import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createCreatorChain, type CreatorChain } from "@blast/server/modules/social/creator-earnings/chain.ts";
import { createCreatorEarningsRoute } from "@blast/server/modules/social/creator-earnings/route.ts";

export function creatorEarningsRoute() {
  return processSingleton("social.creator-earnings", () => {
    let reads: CreatorChain | undefined;
    return createCreatorEarningsRoute({
      kit: sharedSocialRouteKit(),
      database: () =>
        autocommitReader(primaryPool(), "social", { label: "social.creator-earnings" }),
      blastWallet: blastWalletOf,
      async chain(signal) {
        const gate = presaleDeploymentGate();
        if (!mainnetIdentity(gate.state)) return null;
        const identity = await gate.authorize({ signal });
        const baseUrl = presaleNodeUrl(gate.state, runtimeConfig().suiNodeUrl);
        if (!baseUrl) return null;
        reads ??= createCreatorChain(new SuiGrpcClient({ network: "mainnet", baseUrl, format: "text", fetch: boundedFetch(8_000) }), identity);
        return reads;
      },
    });
  });
}
