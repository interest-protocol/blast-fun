import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";
import type { MarketUpstream } from "@blast/server/modules/launchpad-market/routes.ts";
import { cachedMarketUpstream } from "@blast/server/modules/launchpad-market/public-cache.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";

/** This server's blast-infra (`RuntimeConfig.infra`): its origin and the fetch that carries its key. */
export function marketUpstream(): MarketUpstream {
  const { infra } = runtimeConfig();
  return cachedMarketUpstream({ origin: infra.origin, fetch: blastInfraFetch({ infra }) }, publicReadCache("market"));
}
