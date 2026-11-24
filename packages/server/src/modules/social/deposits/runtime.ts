import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createBridgeActivationGate } from "@blast/server/modules/presale/bridge/activation.ts";
import { createCachedCircle, createCircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import { PostgresBridgeActivations, PostgresBridgeTransfers } from "@blast/core/modules/presale/bridge/repository.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialDepositRoutes, type SocialDepositRoutes } from "@blast/server/modules/social/deposits/route.ts";

/**
 * The production deposit routes: the shared social kit, the primary, and the
 * presale bridge exactly as its own routes wire it (`presale/bridge/runtime.ts`)
 * — the activation gate over the latest record and the configuration from
 * `PRESALE_BRIDGE_FORWARDING`, `PRESALE_BRIDGE_RELAYER_ADDRESS` and the
 * deployment identity's Sui CCTP ids; Circle's mainnet Iris API through the
 * cached client; the transfer registry the relayer worker reads. The bridge
 * is off until an operator records a complete activation checklist, and so
 * is every deposit from another chain.
 */
export function socialDepositRoutes(): SocialDepositRoutes {
  return processSingleton("social.deposit-routes", () => {
    let transfers: PostgresBridgeTransfers | undefined;
    let records: PostgresBridgeActivations | undefined;
    const transferStore = () => (transfers ??= new PostgresBridgeTransfers(primaryPool()));
    const recordStore = () => (records ??= new PostgresBridgeActivations(primaryPool()));
    const gate = createBridgeActivationGate({
      records: { latest: () => recordStore().latest(), anyComplete: () => recordStore().anyComplete() },
      configuration: () => runtimeConfig().bridge,
    });
    return createSocialDepositRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.deposit" }),
      activation: () => gate.current(),
      circle: createCachedCircle(createCircleIris()),
      transfers: {
        register: (input) => transferStore().register(input),
        find: (id) => transferStore().find(id),
        findByHash: (source, txHash) => transferStore().findByHash(source, txHash),
        openRegistrations: (privyDid, limit) => transferStore().openRegistrations(privyDid, limit),
      },
      blastWallet: blastWalletOf,
    });
  });
}
