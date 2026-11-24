import type { ReactNode } from "react";
import { curvePrice, formatPrice } from "@interest-protocol/blast-sdk/launchpad";

import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { MIGRATOR_POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";

import type { TerminalSlots } from "../LaunchpadTerminal";
import { CoinExecution, type CoinActionSlots } from "./CoinExecution";
import { CoinHeader } from "./CoinHeader";
import { CoinOverview } from "./CoinOverview";
import { coinIdentity, describeReason, pageLifecycle, sectionData, venueRoute } from "./coin-view";
import { CoinActivity, type ActivitySource } from "../activity/CoinActivity";
import type { PageOutcome } from "../activity/activity-model";
import type { TransactionExplorer } from "../activity/ActivityView";
import { CoinChart } from "../chart/CoinChart";
import type { ChartSnapshot, ChartSource } from "../chart/chart-client";
import { DEFAULT_CHART_CONTROLS, type ChartControls } from "../chart/chart-model";
import { CoinFees } from "../fees/CoinFees";
import type { FeesSource } from "../fees/fees-client";
import { FeesSection } from "../fees/FeesView";
import { CoinHolders } from "../holders/CoinHolders";
import type { HoldersSource } from "../holders/holders-client";
import { DataState } from "../primitives/DataState";
import { placeholderTerminalSlots } from "../terminal-placeholders";
import { CoinTheses } from "../theses/CoinTheses";

export type { BidSlotContext, CoinActionSlots, MigrationSlotContext, TradeSlotContext } from "./CoinExecution";

/**
 * Market data as the browser reaches it: through this app's
 * `/api/launchpad/market` routes, for the deployment the page serves. It
 * never names blast-infra's origin: the browser does not talk to blast-infra.
 */
export type BrowserMarket = Readonly<{ expected: ExpectedDeployment | null }>;

/** What the Activity destination needs beyond the page: the configured explorer and a durable link's record. */
export type ActivityOptions = Readonly<{ explorer: TransactionExplorer | null; anchor: string | null }>;

/** The page request's own choices for its slots; each defaults when absent. */
export type CoinSlotOptions = Readonly<{
  chartControls?: ChartControls;
  initialChart?: ChartSnapshot;
  initialActivity?: PageOutcome<ActivityRow>;
  compact?: boolean;
  quoteLabel?: string;
  activity?: ActivityOptions;
  /** Renders a confirmed launch's Theses; the page's renders them with posting. Default: read only. */
  theses?: ThesesSlot;
}>;

/** A confirmed launch's Theses destination, from its launch ID and ticker (null when unknown). */
export type ThesesSlot = (launch: Readonly<{ launchId: string; symbol: string | null }>) => ReactNode;

const READ_ONLY_THESES: ThesesSlot = ({ launchId, symbol }) => (
  <CoinTheses launchId={launchId} symbol={symbol} posting={{ unavailable: "Posting is not configured here." }} />
);

/**
 * The Theses destination: the launch's public posts, which the browser reads
 * from this app (social records joined to the launch's canonical identity),
 * and the post form where posting is configured. Without a confirmed launch
 * it is Unavailable.
 */
function thesesSlot(page: CoinPage, theses: ThesesSlot) {
  if (!page.confirmed) {
    return (
      <DataState state={{ status: "unavailable", reason: "neither blast-infra nor the node confirms this launch" }} subject="thesis" recovery="">
        {() => null}
      </DataState>
    );
  }
  const { coinType, symbol } = coinIdentity(page);
  return theses({ launchId: page.launchId, symbol: coinType ? symbol : null });
}

/** Where the browser reads the launch's activity, or why it cannot. */
function activitySource(page: CoinPage, market: BrowserMarket | null, options: ActivityOptions, quoteLabel?: string): ActivitySource | string {
  if (!market) return "this app's blast-infra connection is not configured";
  if (!page.confirmed) return "neither blast-infra nor the node confirms this launch";
  const identity = coinIdentity(page);
  return {
    launchId: page.launchId,
    expected: market.expected,
    units: {
      symbol: identity.symbol,
      memeDecimals: identity.memeDecimals,
      coinType: identity.coinType,
      iconUrl: identity.iconUrl,
      quoteSymbol: quoteLabel || identity.quoteSymbol,
      quoteDecimals: identity.quoteDecimals,
      quoteType: identity.quoteType,
    },
    explorer: options.explorer,
    anchor: options.anchor,
    livePools: marketPools(page),
  };
}

/** The pools the chart streams, so the Activity list shares its subscription: the curve, and the venue pool after migration. */
function marketPools(page: CoinPage): string[] {
  const venuePoolKey = venueRoute(page)?.poolKey ?? null;
  return [`blast_curve:${page.launchId}`, ...(venuePoolKey && MIGRATOR_POOL_KEY.test(venuePoolKey) ? [venuePoolKey] : [])];
}

/**
 * The Activity destination: the launch's classified activity (the venue
 * pool's swaps after migration included) and the curve's windowed flow,
 * which the browser reads through
 * this app's market routes. Without blast-infra or a confirmed launch it is
 * Unavailable, never empty.
 */
function activitySlot(page: CoinPage, market: BrowserMarket | null, options: ActivityOptions, quoteLabel?: string, compact?: boolean, initialActivity?: PageOutcome<ActivityRow>) {
  const source = activitySource(page, market, options, quoteLabel);
  if (typeof source !== "string") return <CoinActivity source={source} compact={compact} initialActivity={initialActivity} />;
  return (
    <DataState state={{ status: "unavailable", reason: source }} subject="launch activity" recovery="">
      {() => null}
    </DataState>
  );
}

/** Where the browser reads the coin's holder snapshot, or why it cannot. */
function holdersSource(page: CoinPage, market: BrowserMarket | null): HoldersSource | string {
  // Null when the origin or the expected deployment is not configured (`runtime.ts`).
  if (!market) return "this app's blast-infra connection is not configured";
  if (!page.confirmed) return "neither blast-infra nor the node confirms this launch";
  const identity = coinIdentity(page);
  if (!identity.coinType) return describeReason("coin type unknown");
  return {
    launchId: page.launchId,
    coinType: identity.coinType,
    expected: market.expected,
    symbol: identity.symbol,
    decimals: identity.memeDecimals,
  };
}

/** Where the browser reads the launch's fees, or why it cannot. */
function feesSource(page: CoinPage, market: BrowserMarket | null, quoteLabel?: string): FeesSource | string {
  if (!market) return "this app's blast-infra connection is not configured";
  if (!page.confirmed) return "neither blast-infra nor the node confirms this launch";
  const identity = coinIdentity(page);
  return {
    launchId: page.launchId,
    expected: market.expected,
    units: {
      symbol: identity.symbol,
      memeDecimals: identity.memeDecimals,
      coinType: identity.coinType,
      iconUrl: identity.iconUrl,
      quoteSymbol: quoteLabel ?? identity.quoteSymbol,
      quoteDecimals: identity.quoteDecimals,
      quoteType: identity.quoteType,
    },
  };
}

/**
 * The launch's fees under its overview: the curve's ledger and, after migration, the vault's,
 * which the browser reads through this app's market routes. Without blast-infra or a confirmed
 * launch they are Unavailable, never zero.
 */
function CoinFeesSlot({ page, market, quoteLabel }: Readonly<{ page: CoinPage; market: BrowserMarket | null; quoteLabel?: string }>) {
  const source = feesSource(page, market, quoteLabel);
  if (typeof source !== "string") return <CoinFees source={source} />;
  return (
    <FeesSection launchId={page.launchId}>
      <DataState state={{ status: "unavailable", reason: source }} subject="fees" recovery="">
        {() => null}
      </DataState>
    </FeesSection>
  );
}

/**
 * The Holders destination: the coin's native holder snapshot, which the
 * browser reads through this app's market routes. Without blast-infra, a confirmed
 * launch or a known coin type, it is Unavailable, never zero.
 */
function CoinHoldersSlot({ page, market, compact }: Readonly<{ page: CoinPage; market: BrowserMarket | null; compact?: boolean }>) {
  const source = holdersSource(page, market);
  if (typeof source !== "string") return <CoinHolders source={source} compact={compact} />;
  return (
    <DataState state={{ status: "unavailable", reason: source }} subject="holders" recovery="">
      {() => null}
    </DataState>
  );
}

/** Where the browser reads the coin's chart, or why it cannot. */
function chartSource(page: CoinPage, market: BrowserMarket | null): (ChartSource & { coinType: string }) | string {
  if (!market) return "this app's blast-infra connection is not configured";
  if (!page.confirmed) return "neither blast-infra nor the node confirms this launch";
  const identity = coinIdentity(page);
  if (!identity.coinType) return describeReason("coin type unknown");
  const curve = sectionData(page.curve);
  const virtualQuote = curve?.launch.economics.inputs.virtualQuote;
  const opening = curve?.economics && virtualQuote != null
    ? curvePrice({ virtualQuote, realQuoteReserve: 0n, memeReserve: curve.economics.curveMeme })
    : null;
  const curvePoolKey = `blast_curve:${page.launchId}`;
  // The committed migration, as the curve's summary records it: the marker and the venue pool it opened.
  const route = venueRoute(page);
  const migration = route?.migration ?? null;
  const venuePoolKey = route?.poolKey ?? null;
  return {
    coinType: identity.coinType,
    expected: market.expected,
    curvePoolKey,
    venuePoolKey,
    migration: migration && { cursor: migration.cursor, timestampMs: migration.timestampMs, curvePoolKey, venuePoolKey: migration.poolKey },
    symbol: identity.symbol,
    quoteSymbol: identity.quoteSymbol,
    quoteType: identity.quoteType,
    opening: curve && opening ? { timestampMs: curve.launch.createdAtMs, price: formatPrice(opening) } : undefined,
    memeDecimals: identity.memeDecimals,
    quoteDecimals: identity.quoteDecimals,
  };
}

/**
 * The chart slot: each source pool's own candles, which the browser reads
 * through this app's market routes, around the committed migration. Without
 * blast-infra, a confirmed launch or a known coin type, it is Unavailable.
 */
export function coinChartOptions(page: CoinPage, market: BrowserMarket | null, controls: ChartControls) {
  const source = chartSource(page, market);
  if (typeof source === "string") return source;
  const { coinType, ...chart } = source;
  const graduated = pageLifecycle(page) === "migrated" || page.source.kind === "venue" || chart.migration !== null;
  const livePreset = graduated
    ? chart.venuePoolKey !== null && MIGRATOR_POOL_KEY.test(chart.venuePoolKey)
    : page.source.kind === "curve";
  const initialControls: ChartControls = controls.range === "live" && !livePreset
    ? { ...DEFAULT_CHART_CONTROLS, range: graduated ? "24h" : "all" }
    : controls;
  return { coinType, source: chart, livePreset, initialControls };
}

function CoinChartSlot({ page, market, controls, compact, initialSnapshot }: Readonly<{
  page: CoinPage;
  market: BrowserMarket | null;
  controls: ChartControls;
  compact?: boolean;
  initialSnapshot?: ChartSnapshot;
}>) {
  const chart = coinChartOptions(page, market, controls);
  if (typeof chart !== "string") {
    return <CoinChart key={chart.coinType} {...chart} compact={compact} initialSnapshot={initialSnapshot} />;
  }
  return (
    <DataState state={{ status: "unavailable", reason: chart }} subject="price chart" recovery="">
      {() => null}
    </DataState>
  );
}

/**
 * The permanent coin page's terminal slots for one launch: the selected-coin
 * header, the price chart, the native holder snapshot and the launch activity
 * (all three through `market`, this app's market routes), the overview, and
 * the execution slot with its action slots. `options` carries the request's
 * own choices: the chart's controls (`chartControls`, from the URL) and the
 * Activity destination's explorer and durable link (`activity`), and the
 * Theses with posting (`theses`). Every lifecycle uses this same page.
 */
export function coinTerminalSlots(
  page: CoinPage,
  actions?: CoinActionSlots,
  market: BrowserMarket | null = null,
  options: CoinSlotOptions = {},
): TerminalSlots {
  const chartControls = options.chartControls ?? DEFAULT_CHART_CONTROLS;
  const activity = options.activity ?? { explorer: null, anchor: null };
  return {
    ...placeholderTerminalSlots(page.launchId),
    market: <CoinHeader page={page} expected={market ? market.expected : undefined} />,
    chart: <CoinChartSlot page={page} market={market} controls={chartControls} compact={options.compact} initialSnapshot={options.initialChart} />,
    overview: <CoinOverview page={page} fees={<CoinFeesSlot page={page} market={market} quoteLabel={options.quoteLabel} />} />,
    theses: thesesSlot(page, options.theses ?? READ_ONLY_THESES),
    activity: activitySlot(page, market, activity, options.quoteLabel, options.compact, options.initialActivity),
    holders: <CoinHoldersSlot page={page} market={market} compact={options.compact} />,
    execution: <CoinExecution page={page} actions={actions} market={market} />,
  };
}
