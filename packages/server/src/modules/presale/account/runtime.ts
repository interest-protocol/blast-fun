
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { presaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/runtime.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import { PostgresLinkedWalletStore } from "@blast/server/modules/presale/account/repository.ts";
import { createAccountWalletsRoutes } from "@blast/server/modules/presale/account/wallets.ts";

/**
 * The process's `GET /api/account/wallets` handler: the presale kit, the
 * primary pool and the Privy embedded-wallet resolver. Built on first use;
 * the pools are resolved per request, so a missing setting (such as
 * `DATABASE_URL`) fails that request as `service_unavailable`, never the
 * import or the handler's construction.
 */
export function presaleAccountWalletsRoutes(): ReturnType<typeof createAccountWalletsRoutes> {
  return processSingleton("presale.account-wallets-routes", () =>
    createAccountWalletsRoutes({
      kit: presaleRouteKit(),
      store: new PostgresLinkedWalletStore(() => databaseFor("write")),
      embeddedWallets: { find: (did) => presaleEmbeddedWallets().find(did) },
    }));
}
