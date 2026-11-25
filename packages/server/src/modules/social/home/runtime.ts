import { optionalSource } from "../optional-source.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createPresaleTermsReader, type PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";
import { getSocialConfig } from "@blast/core/modules/social/config/reader.ts";

import type { HomeActivityStreamPage, HomeCoinsByIds, HomeCoinsPage, HomeThreadPage } from "@blast/core/modules/social/contracts/home.ts";
import type { HomeDiscoverBase } from "@blast/server/modules/social/home/coins.ts";
import { socialFeedDatabase } from "@blast/server/modules/social/feed/runtime.ts";
import { socialPortfolioDatabase } from "@blast/server/modules/social/portfolio/runtime.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialHomeRoutes } from "@blast/server/modules/social/home/route.ts";
import { createReadCache } from "@blast/server/modules/social/read-cache.ts";
import type { TraderPortfolioRead } from "@blast/server/modules/social/home/traders.ts";
import type { HomeChartTradesPage, HomeCoinMarket, HomeHoldersPage } from "@blast/core/modules/social/contracts/coin-market.ts";
import { readTrackedPoolLaunches, readTrackedPoolMarket } from "@blast/server/modules/launchpad-market/legacy-fdv.ts";

/**
 * The process's Home routes: the public reads on the replica (like the
 * feed), the Following read on the primary through the kit. The sales'
 * terms (FDV) come from blast-infra's projection through the presale terms
 * reader (each request carrying blast-infra's key), which keeps a final split
 * in memory for an hour.
 */
export const readHomeTerms: PresaleTermsReader = (presaleId, signal) =>
  optionalSource("home_presale_terms", () => processSingleton("social.home-terms", () => {
    const { infra } = runtimeConfig();
    return createPresaleTermsReader({ origin: () => infra.origin, fetch: blastInfraFetch({ infra }), timeoutMs: 2_500, cacheMs: 3_600_000, maxEntries: 2_000 });
  })(presaleId, signal), null);

export function socialHomeRoutes(): ReturnType<typeof createSocialHomeRoutes> {
  return processSingleton("social.home-routes", () => createSocialHomeRoutes({
    kit: sharedSocialRouteKit(),
    database: socialFeedDatabase,
    ledgerDatabase: socialPortfolioDatabase,
    wallets: socialAccounts(),
    config: getSocialConfig,
    terms: readHomeTerms,
    trackedPoolMarket: readTrackedPoolMarket,
    trackedPoolLaunches: readTrackedPoolLaunches,
    caches: homeReadCaches(),
  }));
}

/**
 * The page's reads are public and the same for everyone, so a process keeps
 * each answer for as long as the CDN keeps the route's (`s-maxage=10`): a
 * burst of page views shares one read per distinct view instead of each
 * scanning the window's activity rows again on the replica. In-flight reads
 * are shared too. A failed read is not kept. Bounded; the oldest entries go.
 * Discover alone also serves its last good page while it refreshes
 * (`HOME_DISCOVER_STALE_MS`).
 */
export const HOME_PAGE_READ_TTL_MS = 10_000;
/**
 * How much longer than its TTL a Discover page may be served while it
 * refreshes: the twenty seconds of stale revalidation public discovery already
 * permits (`docs/architecture/latency-and-capacity.md`), so no answer is older than 30 s.
 */
export const HOME_DISCOVER_STALE_MS = 20_000;
function homeReadCaches() {
  return processSingleton("social.home-read-caches", () => ({
    activity: createReadCache<HomeActivityStreamPage>(HOME_PAGE_READ_TTL_MS, 64),
    thread: createReadCache<HomeThreadPage>(HOME_PAGE_READ_TTL_MS, 64),
    // Every Home tab reads this. Past ten seconds the last good page goes out
    // (no-store) while one load replaces it, so a slow or failed refresh
    // (57014 at the 2 s statement timeout) does not reach readers while that
    // page is under 30 s old.
    discover: createReadCache<HomeCoinsPage>(HOME_PAGE_READ_TTL_MS, 64, Date.now, { ms: HOME_DISCOVER_STALE_MS, label: "social.home.discover" }),
    // Each holds a whole window's rows: two windows times the few flag sets clients send, and a small Almost graduated set beside each.
    discoverBase: createReadCache<HomeDiscoverBase>(HOME_PAGE_READ_TTL_MS, 12),
    coins: createReadCache<HomeCoinsByIds>(HOME_PAGE_READ_TTL_MS, 64),
    portfolios: createReadCache<ReadonlyMap<string, TraderPortfolioRead>>(HOME_PAGE_READ_TTL_MS, 64),
    market: createReadCache<HomeCoinMarket>(HOME_PAGE_READ_TTL_MS, 256),
    holders: createReadCache<HomeHoldersPage>(HOME_PAGE_READ_TTL_MS, 128),
    trades: createReadCache<HomeChartTradesPage>(HOME_PAGE_READ_TTL_MS, 256),
  }));
}
