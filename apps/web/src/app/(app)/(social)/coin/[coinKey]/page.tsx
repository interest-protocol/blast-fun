import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { CoinTypeTag } from "#web/components/blast-ui/CoinTypeTag.tsx";

import { BondingCoinScreen, LegacyCoinScreen } from "#web/components/social/bonding/BondingCoinScreen.tsx";
import { LegacyCoinChart } from "#web/components/social/coins/LegacyCoinChart.tsx";
import { allChartInterval, CHART_CONTROLS_COOKIE, LIVE_CHART_INTERVALS, DEFAULT_CHART_CONTROLS, parseChartControls, parseLiveChartControls, preferredChartControls } from "#web/components/launchpad/chart/chart-model.ts";
import { CoinLive } from "#web/components/launchpad/coin/CoinLive.tsx";
import { LiveScreen } from "#web/components/launchpad/coin/LiveScreen.tsx";
import { coinIdentity, pageLifecycle, venueRoute } from "#web/components/launchpad/coin/coin-view.ts";
import { coinChartOptions, coinTerminalSlots, type CoinActionSlots } from "#web/components/launchpad/coin/CoinSlots.tsx";
import { readActivityPage } from "#web/components/launchpad/activity/activity-client.ts";
import { listStart } from "#web/components/launchpad/activity/activity-feed.ts";
import { readChartSnapshot } from "#web/components/launchpad/chart/chart-client.ts";
import { initialMarketDependencies, wantsInitialMarket } from "#web/modules/launchpad-coin/initial-market.ts";
import { CoinMigrationSlot } from "#web/components/launchpad/migration/CoinMigrationSlot.tsx";
import { openingBidActions } from "#web/components/launchpad/opening/opening-slot.tsx";
import { CoinTradeExecution, GraduatedCoinTrade } from "#web/components/launchpad/trade/CoinTrade.tsx";
import { coinTradeActions } from "#web/components/launchpad/trade/coin-trade-slot.tsx";
import { CoinThesesSlot } from "#web/components/launchpad/theses/CoinThesesSlot.tsx";
import { serverTradeAvailability, serverOpeningAvailability } from "#web/components/launchpad/trade/server-availability.ts";
import { webConfig } from "#web/lib/server-config.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { refreshIntervalMs } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { parseCoinRouteKey, readCoinRoute } from "#web/modules/launchpad-coin/read.ts";
import { coinShareIdentity, coinShareMetadata } from "#web/modules/launchpad-coin/share.ts";
import { activityAnchor } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { CoinPageTransfer } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { indexedPoolCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";

type Params = Promise<{ coinKey: string }>;

/** `refreshIntervalMs` for a page whose sections all read cleanly. */
const HEALTHY_REFRESH_MS = 30_000;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * A durable activity link's record (`?activity=<checkpoint>:<tx>:<event>:<sub>`,
 * a launch activity row's position or a venue trade's cursor), or null when
 * the parameter is absent or not one position.
 */
function activityLink(launchId: string, value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return activityAnchor(launchId, value).position;
  } catch {
    return null;
  }
}

// A confirmed launch's Theses, with posting where this app names its deployment.
const THESES = ({ launchId, symbol }: Readonly<{ launchId: string; symbol: string | null }>) => (
  <CoinThesesSlot launchId={launchId} symbol={symbol} />
);

// Complete migration is public: any connected wallet may run it while the
// launch object is MigrationReady on a supported route, whatever the watcher does.
const MIGRATION_ACTIONS: CoinActionSlots = {
  migration: ({ launchId, route }) => <CoinMigrationSlot launchId={launchId} venue={route.venue} />,
};

async function resolveCoinPage(params: Params) {
  const key = parseCoinRouteKey((await params).coinKey);
  return key ? readCoinRoute(key) : { kind: "not-found" } as const;
}

const missingMetadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const resolved = await resolveCoinPage(params);
  if (resolved.kind === "not-found") return missingMetadata;
  if (resolved.kind === "presale") return { alternates: { canonical: presalePath(resolved.presaleId) } };
  const coin = coinShareIdentity(resolved);
  if (coin) return coinShareMetadata(coin);
  if (resolved.kind === "launch" && resolved.transfer.read.kind === "coin") {
    return { title: "Launch not confirmed", robots: { index: false, follow: false } };
  }
  return missingMetadata;
}

// Resolve status before streaming. A segment loading.tsx would commit an HTTP 200 early.
function chartWithAllInterval(chart: ReturnType<typeof coinChartOptions>, query: URLSearchParams, saved: string) {
  if (typeof chart === "string" || chart.initialControls.range !== "all") return chart;
  const preferences = new URLSearchParams(saved);
  const explicit = query.getAll("interval").length === 1 ? query.get("interval") : null;
  const stored = preferences.get("interval.all") ?? (preferences.get("range") === "all" ? preferences.get("interval") : null);
  if (LIVE_CHART_INTERVALS.some(interval => interval === explicit || interval === stored)) return chart;
  return { ...chart, initialControls: { ...chart.initialControls, interval: allChartInterval(chart.source.launchAt, Date.now()) } };
}

export default async function CoinPage({ params, searchParams }: { params: Params; searchParams?: SearchParams }) {
  const resolved = await resolveCoinPage(params);
  if (resolved.kind === "not-found") notFound();
  if (resolved.kind === "presale") {
    const query = new URLSearchParams();
    for (const [key, values] of Object.entries((await searchParams) ?? {})) {
      for (const value of typeof values === "string" ? [values] : values ?? []) query.append(key, value);
    }
    const suffix = query.size ? `?${query}` : "";
    redirect(presalePath(resolved.presaleId) + suffix);
  }
  if (resolved.kind === "generic") return renderGenericCoin(resolved, searchParams);
  return renderLaunchCoin((await params).coinKey, resolved.launchId, resolved.transfer, searchParams);
}

async function renderGenericCoin(coin: Readonly<{ coinType: string; name: string; symbol: string }>, searchParams?: SearchParams) {
  const poolCoin = indexedPoolCoin(coin.coinType);
  if (!poolCoin) {
    return (
      <>
        <PageHeader title={<span className="ticker">{coin.name}</span>} sub={<Ticker symbol={coin.symbol} />} />
        <CoinTypeTag coinType={coin.coinType} />
      </>
    );
  }

  const { coinType, name, symbol, decimals, logoUrl, poolKey, poolKeys, quote, major } = poolCoin;
  const [{ trading, liveScreen }, search] = await Promise.all([requestLaunchFlags(), searchParams]);
  const controls = parseChartControls(search ?? {}, { ...DEFAULT_CHART_CONTROLS, range: "24h" });
  return (
    <LiveScreen enabled={liveScreen}><LegacyCoinScreen
      coinType={coinType} name={name} symbol={symbol} logoUrl={logoUrl} decimals={decimals} poolKey={poolKey} poolKeys={poolKeys} quote={quote} major={major}
      chart={<LegacyCoinChart poolKey={poolKey} symbol={symbol} decimals={decimals} quote={quote} initialControls={controls} />}
      trade={trading ? <GraduatedCoinTrade coinType={coinType} name={name} symbol={symbol} decimals={decimals} iconUrl={logoUrl} /> : null}
      legacy={poolCoin.category === "Legacy"}
      verified={poolCoin.category === "Legacy" && poolCoin.verifiedTeam}
      verifiedCommunity={"verifiedCommunity" in poolCoin && poolCoin.verifiedCommunity}
    /></LiveScreen>
  );
}

async function renderLaunchCoin(
  coinKey: string,
  launchId: string,
  { read, browserMarket, explorer, details, verifiedTeam }: CoinPageTransfer,
  searchParams?: SearchParams,
) {
  if (read.kind === "not-found") notFound();
  const { page } = read;
  // The curve and venue rails mount in the execution slot's `trade` contract,
  // only where the fresh launch object allows curve trading or the launch
  // migrated to its recorded venue; the opening round's facts and Join mount
  // in its `bid` contract while the launch object is in its opening round.
  // Complete migration mounts in its `migration` contract while MigrationReady.
  // They need a released, connected deployment; until then each says why
  // nothing can be signed.
  const [flags, requestHeaders, requestCookies, query] = await Promise.all([requestLaunchFlags(), headers(), cookies(), searchParams]);
  const tradeAvailability = serverTradeAvailability(webConfig(), flags.trading);
  const connection = {
    privyAppId: webConfig().privyAppId,
    nonce: requestHeaders.get("x-nonce") ?? "",
    migrationPosition: venueRoute(page)?.migration?.cursor ?? null,
  };
  const actions = {
    ...coinTradeActions(tradeAvailability),
    ...openingBidActions(
      serverOpeningAvailability("Joining the opening round"),
      serverOpeningAvailability("Settling the opening round"),
    ),
    ...MIGRATION_ACTIONS,
  };
  const search = query ?? {};
  const identity = coinIdentity(page);
  const defaults = pageLifecycle(page) === "migrated" ? { interval: "15m", range: "24h" } as const : DEFAULT_CHART_CONTROLS;
  const urlControls = parseLiveChartControls(search, defaults);
  const savedControls = requestCookies.get(CHART_CONTROLS_COOKIE)?.value ?? "";
  const chartQuery = new URLSearchParams();
  for (const name of ["interval", "range"]) {
    const value = search[name];
    for (const field of typeof value === "string" ? [value] : value ?? []) chartQuery.append(name, field);
  }
  const requestedControls = preferredChartControls(savedControls, chartQuery.toString(), urlControls);
  const anchor = activityLink(launchId, search.activity);
  const market = browserMarket && page.confirmed && wantsInitialMarket(new Headers(requestHeaders), `/coin/${coinKey}`)
    ? initialMarketDependencies(browserMarket.expected, new Headers(requestHeaders))
    : null;
  const chart = chartWithAllInterval(coinChartOptions(page, browserMarket, requestedControls), chartQuery, savedControls);
  const [initialChart, initialActivity] = await Promise.all([
    market && typeof chart !== "string" ? readChartSnapshot(chart.source, chart.initialControls, market, Date.now()) : undefined,
    market ? readActivityPage(launchId, listStart(launchId, anchor), market) : undefined,
  ]);
  const slots = coinTerminalSlots(page, actions, browserMarket, {
    chartControls: typeof chart === "string" ? requestedControls : chart.initialControls, initialChart, initialActivity, activity: { explorer, anchor }, theses: THESES, quoteLabel: "", compact: true,
  });
  const execution = <CoinTradeExecution key={launchId} page={page} availability={tradeAvailability} connection={connection}>{slots.execution}</CoinTradeExecution>;
  const refreshMs = refreshIntervalMs(page);
  // The live screen loads once and listens; its timer rests while the stream listens on a healthy read.
  const healthy = refreshMs === HEALTHY_REFRESH_MS && page.confirmed && browserMarket !== null;
  return (
    <LiveScreen enabled={flags.liveScreen}>
      <BondingCoinScreen page={page} details={details ?? null} verified={verifiedTeam === true} slots={{ ...slots, execution }} expected={browserMarket?.expected ?? null} />
      <CoinLive launchId={launchId} coinType={identity.coinType} tradable={page.tradable} refreshMs={refreshMs} restWhileListening={flags.liveScreen && healthy} />
    </LiveScreen>
  );
}
