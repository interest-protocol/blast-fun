import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { CoinTypeTag } from "#web/components/blast-ui/CoinTypeTag.tsx";

import { BondingCoinScreen, LegacyCoinScreen } from "#web/components/social/bonding/BondingCoinScreen.tsx";
import { LegacyCoinChart } from "#web/components/social/coins/LegacyCoinChart.tsx";
import { DEFAULT_CHART_CONTROLS, parseChartControls, parseLiveChartControls } from "#web/components/launchpad/chart/chart-model.ts";
import { CoinLive } from "#web/components/launchpad/coin/CoinLive.tsx";
import { coinIdentity, pageLifecycle, venueRoute } from "#web/components/launchpad/coin/coin-view.ts";
import { coinTerminalSlots, type CoinActionSlots } from "#web/components/launchpad/coin/CoinSlots.tsx";
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
  return renderLaunchCoin(resolved.launchId, resolved.transfer, searchParams);
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

  const { coinType, name, symbol, decimals, logoUrl, poolKey } = poolCoin;
  const [{ trading }, search] = await Promise.all([requestLaunchFlags(), searchParams]);
  const controls = parseChartControls(search ?? {}, { ...DEFAULT_CHART_CONTROLS, range: "24h" });
  return (
    <LegacyCoinScreen
      coinType={coinType} name={name} symbol={symbol} logoUrl={logoUrl} decimals={decimals} poolKey={poolKey}
      chart={<LegacyCoinChart poolKey={poolKey} symbol={symbol} decimals={decimals} initialControls={controls} />}
      trade={trading ? <GraduatedCoinTrade coinType={coinType} name={name} symbol={symbol} decimals={decimals} iconUrl={logoUrl} /> : null}
      legacy={poolCoin.category === "Legacy"}
      verified={poolCoin.category === "Legacy" && poolCoin.verifiedTeam}
      verifiedCommunity={"verifiedCommunity" in poolCoin && poolCoin.verifiedCommunity}
    />
  );
}

async function renderLaunchCoin(
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
  const [flags, requestHeaders] = await Promise.all([requestLaunchFlags(), headers()]);
  const tradeAvailability = serverTradeAvailability(webConfig(), flags.trading && flags.launchpad);
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
  // The browser reads market data (the chart's candles, the holder snapshot
  // and the activity) through this app's `/api/launchpad/market` routes; it
  // is never handed blast-infra's origin.
  // One read of the query feeds both URL-held choices: the chart's interval
  // and range (a direct link reads the same history) and a durable activity
  // link, which opens Activity (on mobile, the Theses view that holds it) at
  // its record.
  const search = (await searchParams) ?? {};
  const identity = coinIdentity(page);
  const chartControls = parseLiveChartControls(search, pageLifecycle(page) === "migrated"
    ? { ...DEFAULT_CHART_CONTROLS, range: "24h" } : DEFAULT_CHART_CONTROLS);
  const anchor = activityLink(launchId, search.activity);
  const slots = coinTerminalSlots(page, actions, browserMarket, { chartControls, activity: { explorer, anchor }, theses: THESES, quoteLabel: "", compact: true });
  const execution = <CoinTradeExecution key={launchId} page={page} availability={tradeAvailability} connection={connection}>{slots.execution}</CoinTradeExecution>;
  return (
    <>
      <BondingCoinScreen page={page} details={details ?? null} verified={verifiedTeam === true} slots={{ ...slots, execution }} />
      <CoinLive launchId={launchId} coinType={identity.coinType} tradable={page.tradable} refreshMs={refreshIntervalMs(page)} />
    </>
  );
}
