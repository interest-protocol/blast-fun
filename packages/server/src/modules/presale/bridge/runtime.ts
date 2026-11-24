import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import { createBridgeActivationGate } from "./activation.ts";
import { createCachedCircle, createCircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import { PostgresBridgeActivations, PostgresBridgeTransfers } from "@blast/core/modules/presale/bridge/repository.ts";
import { createPresaleBridgeRoutes, type PresaleBridgeRoutes } from "./routes.ts";

/**
 * The process's bridge routes: the shared presale route kit, one cached Iris
 * client (Circle mainnet), the primary database, and the configuration from
 * `PRESALE_BRIDGE_FORWARDING`, `PRESALE_BRIDGE_RELAYER_ADDRESS` and the
 * deployment identity. The database is reached on first use, so a missing
 * setting fails a request as `service_unavailable`, never the module.
 */
export function presaleBridgeRoutes(): PresaleBridgeRoutes {
  return processSingleton("presale.bridge-routes", () => {
    let transfers: PostgresBridgeTransfers | undefined;
    let records: PostgresBridgeActivations | undefined;
    const transferStore = () => (transfers ??= new PostgresBridgeTransfers(databaseFor("write")));
    const recordStore = () => (records ??= new PostgresBridgeActivations(databaseFor("write")));
    return createPresaleBridgeRoutes({
      kit: presaleRouteKit(),
      circle: createCachedCircle(createCircleIris()),
      activation: createBridgeActivationGate({
        records: { latest: () => recordStore().latest(), anyComplete: () => recordStore().anyComplete() },
        configuration: runtimeConfig().bridge,
      }),
      transfers: {
        register: (input) => transferStore().register(input),
        find: (id) => transferStore().find(id),
        findByHash: (source, txHash) => transferStore().findByHash(source, txHash),
        openRegistrations: (privyDid, limit) => transferStore().openRegistrations(privyDid, limit),
      },
    });
  });
}
