import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { productionPrivyGateway } from "@blast/server/lib/privy-adapter/http-gateway.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";

import type { PrivyProviderGateway } from "@blast/core/lib/privy-adapter/types.ts";

/** The process's one Privy gateway, built from the runtime config on first use. */
export function privyGateway(): PrivyProviderGateway {
  return processSingleton("privy.gateway", () => productionPrivyGateway(runtimeConfig().privy));
}
