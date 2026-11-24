import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";

import type { SuiGrpcClient } from "@mysten/sui/grpc";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createCachedCircleWithdraw, createCircleWithdrawIris } from "@blast/server/modules/presale/bridge/circle-withdraw.ts";
import type { BridgeConfiguration } from "@blast/core/modules/presale/bridge/contracts.ts";
import { PostgresBridgeActivations } from "@blast/core/modules/presale/bridge/repository.ts";
import { suiBurnIds } from "@blast/core/modules/presale/bridge/sui-burn.ts";
import { createBridgeWithdrawGate } from "@blast/server/modules/presale/bridge/withdraw-activation.ts";
import { presaleDeploymentGate } from "@blast/server/modules/presale/deployment/runtime.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";

import { sharedSocialRouteKit, socialMainnetClient } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { fullnodeTradeChain, type TradeChain } from "@blast/server/modules/social/trades/chain.ts";
import { createSocialBridgeWithdrawRoutes, fullnodeBurnLookup, type SocialBridgeWithdrawRoutes } from "@blast/server/modules/social/bridge-withdraw/route.ts";

/** The mainnet node (`socialMainnetClient`), one per process: the wallet's coins, the dry runs and the settle reads. */
function mainnet(): SuiGrpcClient {
  return socialMainnetClient("social.bridge-withdraw-fullnode");
}

/**
 * The bridge's configuration as the presale bridge reads it
 * (`PRESALE_BRIDGE_FORWARDING`, `PRESALE_BRIDGE_RELAYER_ADDRESS`, the
 * deployment identity). A ready identity is always mainnet; any other state
 * keeps every destination off.
 */
function configuration(): BridgeConfiguration {
  return runtimeConfig().bridge;
}

/**
 * The production withdrawal routes over the shared social kit: the primary,
 * the bridge's activation records (read on every request), one cached Circle
 * Iris client per process (mainnet), the mainnet fullnode, the presale
 * sponsor in-process (its gas pool, reservations and deployment gate), and
 * the Blast wallet resolver the coins sheet uses. The database and the
 * identity are reached on first use, so a missing setting fails a request as
 * `service_unavailable` (or keeps every destination off), never the module.
 */
export function socialBridgeWithdrawRoutes(): SocialBridgeWithdrawRoutes {
  return processSingleton("social.bridge-withdraw-routes", () => {
    let records: PostgresBridgeActivations | undefined;
    const recordStore = () => (records ??= new PostgresBridgeActivations(databaseFor("write")));
    const gate = createBridgeWithdrawGate({ records: { latest: () => recordStore().latest() }, configuration });
    const circle = createCachedCircleWithdraw(createCircleWithdrawIris());
    let chain: TradeChain | undefined;
    return createSocialBridgeWithdrawRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.bridge-withdraw" }),
      gate: () => gate,
      circle: () => circle,
      chain: () => (chain ??= fullnodeTradeChain(mainnet())),
      sponsor: sponsorService,
      burnIds: () => {
        const identity = mainnetIdentity(presaleDeploymentGate().state);
        return identity ? suiBurnIds(identity.cctp) : null;
      },
      burns: () => fullnodeBurnLookup(mainnet),
      blastWallet: blastWalletOf,
    });
  });
}
