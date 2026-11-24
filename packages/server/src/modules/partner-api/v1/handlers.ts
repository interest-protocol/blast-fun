import { readLegacyMarket } from "@blast/server/modules/launchpad-market/legacy-fdv.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { DAILY_STATS_READ, marketSourceBucket, WALLET_LAUNCHES_READ, webPath } from "@blast/server/modules/partner-api/v1/paths.ts";
import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";
import { handleWalletLaunchesRequest } from "@blast/server/modules/launchpad-discovery/wallet-launches.ts";
import { databaseSearchSources, handleSearchRequest } from "@blast/server/modules/launchpad-search/resource.ts";
import { marketUpstream } from "@blast/server/modules/launchpad-market/shared-runtime.ts";
import { createAdmittedMarketRead, createMarketRoutes } from "@blast/server/modules/launchpad-market/routes.ts";
import { presaleAllowlistProofRoute } from "@blast/server/modules/presale/allowlists/runtime.ts";
import { createSocialPresaleRuntimeRoutes } from "@blast/server/modules/social/presales/shared-runtime.ts";
import { createSocialPricesRuntimeRoute } from "@blast/server/modules/social/prices/shared-runtime.ts";
import { socialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { createDefillamaRead } from "@blast/core/modules/defillama/reads.ts";
import { defillamaReportingReads } from "@blast/core/modules/defillama/runtime.ts";
import { handleCoinMetadataRequest } from "./coin-metadata.ts";
import { handleDailyStatsRequest } from "./daily-stats.ts";

const limitCodes = { rateLimited: "LAUNCHPAD_RATE_LIMITED", unavailable: "LAUNCHPAD_READ_UNAVAILABLE" } as const;

const WALLET_LAUNCHES_PATH = webPath(WALLET_LAUNCHES_READ);

/** The wallet a `/api/launchpad/wallets/{address}/launches` read names. */
function walletOf(request: Request): string {
  return routeSegments(WALLET_LAUNCHES_PATH, new URL(request.url).pathname)?.address ?? "";
}

/** Inject endpoint admission directly; no client header can select this binding. */
export function createPartnerV1Handlers(
  limiter: RateLimitPort,
  effectRead?: (request: Request) => Promise<Response>,
): PartnerV1Handlers {
  const kit = socialRouteKit(limiter);
  const presales = createSocialPresaleRuntimeRoutes(kit);
  const prices = createSocialPricesRuntimeRoute(kit);
  const market = effectRead
    ? createAdmittedMarketRead(limiter, marketSourceBucket, effectRead)
    : createMarketRoutes({ limiter, upstream: marketUpstream }).handle;
  const defillama = createDefillamaRead(() => defillamaReportingReads(runtimeConfig().defillama));
  // Built on first use: a presale configuration fault fails proofs, not every partner read.
  let proof: ReturnType<typeof presaleAllowlistProofRoute> | undefined;
  return {
    defillama: (request, client) => withRouteLimits(client, ["defillama_read"], () => defillama(request), { ...limitCodes, limiter }),
    daily_stats: (request, client) =>
      withRouteLimits(client, [DAILY_STATS_READ.bucket], () => handleDailyStatsRequest(request), { ...limitCodes, limiter }),
    presales: (request, client) => presales.list.GET(request, client),
    featured: (request, client) => presales.featured.GET(request, client),
    presale: (request, client) => presales.presale.GET(request, client),
    presale_proof: (request, client) => (proof ??= presaleAllowlistProofRoute(limiter))(request, client),
    prices: (request, client) => prices.GET(request, client),
    market,
    coin_metadata: (request, client) => withRouteLimits(
      client,
      ["launchpad_market_coin"],
      () => handleCoinMetadataRequest(request),
      { rateLimited: "rate_limited", unavailable: "unavailable", limiter },
    ),
    discovery: (request, client) => withRouteLimits(client, ["launchpad_discovery"], () => handleDiscoveryRequest(request, undefined, undefined, undefined, publicReadCache("market"), readLegacyMarket), { ...limitCodes, limiter }),
    wallet_launches: (request, client) =>
      withRouteLimits(client, ["launchpad_wallet_launches"], () => handleWalletLaunchesRequest(request, walletOf(request)), { ...limitCodes, limiter }),
    search: (request, client) => withRouteLimits(client, ["launchpad_search"], () => handleSearchRequest(request, databaseSearchSources()), { ...limitCodes, limiter }),
  };
}
