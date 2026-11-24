import { privyGateway } from "@blast/server/config/privy-gateway.ts";

import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { createPresaleEmbeddedWallets, type PresaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/service.ts";

/** The embedded wallet resolver over the primary pool and the process's Privy gateway. */
export function presaleEmbeddedWallets(): PresaleEmbeddedWallets {
  return createPresaleEmbeddedWallets({
    pool: databaseFor("write"),
    gateway: { getUser: (did) => privyGateway().getUser(did) },
  });
}
