import { ChartLastTrade } from "./ChartLastTrade.tsx";
import { useCandleTrade } from "./chart-trade-context.ts";
import { PoolCandleChart } from "#web/components/charts/PoolCandleChart.tsx";
import dynamic from "next/dynamic";
import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { poolPrices } from "#web/components/charts/candle-data.ts";
import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { Checkbox, Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { useLaunchWallet, useWalletTrades } from "../activity/wallet-trades";
import { tradeWalletLabels } from "../activity/wallet-labels";
import { walletMarkerKey, type WalletChartTrade, type WalletRipple } from "#web/components/charts/wallet-markers.ts";
import { useContext, useMemo, useRef, useState } from "react";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { saveChartPreference, useChartPreference } from "./chart-preferences";

import { candleBucketStart, comparePrices } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";

import { exactDecimal, exactText, multiplyExact } from "@blast/core/lib/exact-amount.ts";
import { readableUsd } from "#web/lib/market-format.ts";
import { formatPricePerToken, formatTime, shiftDecimal } from "../coin/coin-format";
import { sectionState } from "../coin/coin-view";
import { DataState } from "../primitives/DataState";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { DataTable, type DataTableColumn } from "../primitives/DataTable";
import type { SectionState } from "../primitives/data-state";
import primitives from "../primitives/primitives.module.css";
import type { ChartSource } from "./chart-client";
import { chartGeometry, type DrawnSeries } from "./chart-geometry";
import { CHART_RANGES, LIVE_CHART_CONTROLS, fitControls, rangeIntervals, LIVE_CHART_SPAN_MS, candleGaps, chartLatestTimestamp, chartOpening, chartSources, pageTruncated, type ChartCandlePage, type ChartControls, type ChartRange, type ChartRequest, type ChartState, type CandleGap, type SourceState } from "./chart-model";
import { useChartClock } from "./use-chart-clock.ts";
import styles from "./Chart.module.css";
import { ChartPeopleTrades } from "#web/components/charts/kline/chart-people-trades.ts";
import klineStyles from "#web/components/charts/kline/KLineCoinChart.module.css";
import { HIDDEN_AMOUNT, NO_VALUE, venueName } from "@blast/core/lib/format.ts";

export const PRICE_HISTORY_UNAVAILABLE = "Price history couldn’t load.";

/** The coin page's chart library loads only when a chart is on screen. */
const KLineCoinChart = dynamic(() => import("#web/components/charts/kline/KLineCoinChart.tsx"), {
  ssr: false,
  loading: () => <span className={klineStyles.loadingFrame}><SkeletonBox className={klineStyles.loading} /></span>,
});

export type ChartSourceName = "curve" | "venue";
type ChartViewSource = Omit<ChartSource, "curvePoolKey"> & Readonly<{ curvePoolKey: string | null }>;

const RANGE_WORDS: Readonly<Record<ChartRange, string>> = { live: "Last 5 minutes", "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", all: "All history" };

const RANGE_LABEL: Readonly<Record<ChartRange, string>> = {
  live: "Live",
  "1h": "1H",
  "6h": "6H",
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  all: "All",
};

type Row = Readonly<{ kind: "candle"; candle: ChartCandlePage["candles"][number] }> | Readonly<{ kind: "gap"; gap: CandleGap }>;

const isBehind = (section: SourceState | null) => section?.state === "unavailable" || section?.state === "stale";
const hasData = (section: SourceState | null): section is Extract<Section<ChartCandlePage>, { data: ChartCandlePage }> =>
  section !== null && (section.state === "available" || section.state === "stale");

const clock = (ms: number) => formatTime(ms);

/** A price in quote per whole token, cut to seven significant digits; in USD when the quote's rate is known. */
function tokenPrice(price: string | null, source: ChartViewSource, quoteUsd?: string | null): string {
  if (price === null || source.memeDecimals === null || source.quoteDecimals === null) return NO_VALUE;
  const rate = exactDecimal(quoteUsd);
  const whole = rate && exactDecimal(shiftDecimal(price, source.memeDecimals - source.quoteDecimals));
  if (rate && whole) return readableUsd(exactText(multiplyExact(whole, rate)));
  return `${formatPricePerToken(price, source.memeDecimals, source.quoteDecimals)} ${source.quoteSymbol}`;
}

/** How one source is named: the bonding curve, or its venue's pool. */
function sourceLabel(source: ChartSourceName, venuePoolKey: string | null): string {
  if (source === "curve") return "Bonding curve";
  return venuePoolKey ? `${venueName(venuePoolKey.split(":")[0])} pool` : "Venue pool";
}

function displayState(section: SourceState | null, range: ChartRange): SectionState<ChartCandlePage> {
  if (section === null) return { status: "unavailable", reason: "no venue pool is recorded for the migration" };
  if (section.state === "loading") return { status: "loading" };
  if (range === "live" && section.state === "available" && section.data.candles.length === 0) return { status: "empty" };
  return sectionState(section);
}

/** One source's candles as rows, oldest first, each missing interval between them named. */
function rows(page: ChartCandlePage): Row[] {
  const gaps = candleGaps(page);
  return [
    ...page.candles.map((candle): Row => ({ kind: "candle", candle })),
    ...gaps.map((gap): Row => ({ kind: "gap", gap })),
  ].sort((left, right) => (left.kind === "candle" ? left.candle.bucketStart : left.gap.from) - (right.kind === "candle" ? right.candle.bucketStart : right.gap.from));
}

/** Whether a candle closed above, below or at its open, in words, by exact price order. */
function direction(candle: ChartCandlePage["candles"][number]): string {
  const order = comparePrices(candle.close, candle.open);
  return order > 0 ? "Up" : order < 0 ? "Down" : "Unchanged";
}

function CandleTable({ page, label, source, quoteUsd }: Readonly<{ page: ChartCandlePage; label: string; source: ChartViewSource; quoteUsd?: string | null }>) {
  const { amountsHidden } = useShellPrefs();
  const prices = poolPrices(source.memeDecimals, source.quoteDecimals, quoteUsd);
  const price = (value: string) => candleTablePrice(prices, source, value, amountsHidden);
  const onCandle = (cell: (candle: ChartCandlePage["candles"][number]) => string) => (row: Row) =>
    row.kind === "candle" ? cell(row.candle) : "";
  const columns: DataTableColumn<Row>[] = [
    {
      header: "Interval start (UTC)",
      cell: (row) => row.kind === "candle"
        ? <DateStamp at={row.candle.bucketStart} clock plain />
        : <><DateStamp at={row.gap.from} clock plain /> to <DateStamp at={row.gap.to} clock plain /></>,
    },
    {
      header: "Open",
      numeric: true,
      cell: (row) =>
        row.kind === "candle"
          ? price(row.candle.open)
          : `No trades, no candle: ${row.gap.intervals} interval${row.gap.intervals === 1 ? "" : "s"}`,
    },
    { header: "High", numeric: true, cell: onCandle((candle) => price(candle.high)) },
    { header: "Low", numeric: true, cell: onCandle((candle) => price(candle.low)) },
    { header: "Close", numeric: true, cell: onCandle((candle) => price(candle.close)) },
    { header: "Direction", cell: onCandle(direction) },
    { header: "Volume", numeric: true, cell: onCandle((candle) => candleTableVolume(candle.volumeQuote, source, amountsHidden)) },
    {
      header: "Trades",
      numeric: true,
      cell: onCandle((candle) => candle.buys == null || candle.sells == null ? String(candle.trades) : `${candle.buys} buy${candle.buys === 1 ? "" : "s"}, ${candle.sells} sell${candle.sells === 1 ? "" : "s"}`),
    },
  ];
  return (
    <details className={styles.tableDetails}>
      <summary>View {label} chart values</summary>
      <DataTable
        caption={`${label} candles, ${page.interval} intervals, oldest first`}
        columns={columns}
        rows={rows(page)}
        rowKey={(row) => (row.kind === "candle" ? `c${row.candle.bucketStart}` : `g${row.gap.from}`)}
      />
    </details>
  );
}

function candleTablePrice(prices: ReturnType<typeof poolPrices>, source: ChartViewSource, value: string, hidden: boolean) {
  if (hidden) return HIDDEN_AMOUNT;
  if (source.memeDecimals === null || source.quoteDecimals === null) return NO_VALUE;
  const exact = prices.price(value);
  return prices.usd ? `$${exact}` : `${exact} ${source.quoteSymbol}`;
}

function candleTableVolume(atoms: bigint, { quoteDecimals, quoteSymbol }: ChartViewSource, hidden: boolean) {
  if (hidden) return HIDDEN_AMOUNT;
  if (quoteDecimals === null) return NO_VALUE;
  return `${shiftDecimal(atoms.toString(), -quoteDecimals)} ${quoteSymbol}`;
}

/** Says when a page may leave older candles unread: only a full page of a capped read. Live reads a fixed five-minute tape, never older history. */
function limitedNote(page: ChartCandlePage, request: ChartRequest, range: ChartRange): string | null {
  if (range === "live" || !pageTruncated(page, request)) return null;
  const count = `${page.candles.length.toLocaleString("en-US")} candle${page.candles.length === 1 ? "" : "s"}`;
  return range === "all"
    ? `Newest ${count} · older history not loaded.`
    : `Newest ${count} in range · older history not loaded.`;
}

/**
 * Each pool keeps its own candles and gap records around the committed migration.
 * The Live line can carry the close before the window without adding a candle.
 * A read failure keeps the source's last answer marked stale.
 */
function useChartViewControls({
  state,
  source,
  omitCurve,
  quoteUsd,
  controls,
  request: historyRequest,
  hidden,
  pending,
  updates,
  emptyMessage,
  livePreset = false,
  currentPrice,
  diagnostic,
  onControls,
  onToggle,
  onRefresh,
}: Readonly<{
  state: ChartState;
  source: ChartViewSource;
  omitCurve?: boolean;
  quoteUsd?: string | null;
  controls: ChartControls;
  request: ChartRequest;
  hidden: readonly ChartSourceName[];
  pending: boolean;
  /** Current streaming/recovery state, or null for a static chart. */
  updates: string | null;
  emptyMessage?: string;
  livePreset?: boolean;
  currentPrice?: string | null;
  diagnostic?: string;
  onControls: (controls: ChartControls) => void;
  onToggle: (source: ChartSourceName, shown: boolean) => void;
  onRefresh: () => void;
}>) {
  const live = controls.range === "live";
  const now = useChartClock(1_000, live);
  const drawing = chartDrawing({ state, source, omitCurve, historyRequest, hidden, live, now, currentPrice });
  return { source, quoteUsd, controls, pending, updates, emptyMessage, livePreset, diagnostic, onControls, onToggle, onRefresh, ...drawing };
}

function chartDrawing({ state, source, omitCurve, historyRequest, hidden, live, now, currentPrice }: Readonly<{
  state: ChartState;
  source: ChartViewSource;
  omitCurve?: boolean;
  historyRequest: ChartRequest;
  hidden: readonly ChartSourceName[];
  live: boolean;
  now: number | null;
  currentPrice?: string | null;
}>) {
  const chainTime = chartLatestTimestamp(state);
  const liveEnd = live ? candleBucketStart("1s", Math.max(now ?? 0, chainTime)) + 1_000 : null;
  const liveStart = liveEnd === null ? null : liveEnd - LIVE_CHART_SPAN_MS;
  const request = liveStart === null ? historyRequest : { ...historyRequest, from: liveStart };
  const migration = state.migration;
  const holdCurveAfterMigration = live && migration !== null && state.venue?.state === "empty";
  const venuePoolKey = source.venuePoolKey ?? migration?.venuePoolKey ?? null;
  const sources = chartSources(state)
    .filter(({ name }) => name !== "curve" || (!omitCurve && source.curvePoolKey !== null))
    .map((read) => priceSource(read, request, liveStart, source.opening, migration?.timestampMs, holdCurveAfterMigration));
  const label = (name: ChartSourceName) => sourceLabel(name, venuePoolKey);
  const selectable = sources.filter(({ section, carriedClose }) => hasData(section) && (section.data.candles.length > 0 || carriedClose));
  const shown = (name: ChartSourceName) =>
    (selectable.length === 1 && selectable[0]?.name === name) || !hidden.includes(name);

  const drawn: DrawnSeries[] = sources.flatMap(({ name, section, opening, carriedClose }) =>
    hasData(section) && (section.data.candles.length || carriedClose) && shown(name) ? [{
      source: name, page: section.data, opening, carriedClose, observedAt: section.provenance.timestampMs,
      holdAfterMigration: name === "curve" && holdCurveAfterMigration,
    }] : [],
  );
  const latest = drawn.at(-1);
  const close = latest?.page.candles.at(-1)?.close ?? latest?.carriedClose?.price ?? null;
  const hasLatest = latest !== undefined &&
    sources.find(({ name }) => name === latest.source)?.section?.state === "available" &&
    (currentPrice === undefined || (currentPrice === close && latest.source === (venuePoolKey ? "venue" : "curve")));
  // A bounded range runs to blast-infra's committed checkpoint time; all history ends at its last candle.
  const hasPriceUnits = source.memeDecimals !== null && source.quoteDecimals !== null;
  const geometry = hasPriceUnits ? chartGeometry(drawn, migration, request.from, liveEnd ?? (request.from === undefined ? null : chainTime || null)) : null;
  const missingPriceUnits = Boolean(latest) && !hasPriceUnits;
  return { venuePoolKey, request, migration, sources, selectable, drawn, label, shown, geometry, hasPriceUnits, missingPriceUnits, latestAvailable: hasLatest, latest: close };
}

function priceSource(
  { name, section: read }: ReturnType<typeof chartSources>[number],
  request: ChartRequest,
  liveStart: number | null,
  launch: ChartViewSource["opening"],
  migrationAt: number | undefined,
  holdCurveAfterMigration: boolean,
) {
  if (!hasData(read)) return { name, section: read, opening: undefined };
  const from = request.from;
  const candles = from === undefined ? read.data.candles : read.data.candles.filter(({ bucketStart }) => bucketStart >= from);
  const carryFrom = name === "venue" && liveStart !== null ? Math.max(liveStart, migrationAt ?? liveStart) : liveStart;
  const mayCarry = name === "venue" || migrationAt === undefined || holdCurveAfterMigration || (carryFrom !== null && carryFrom < migrationAt);
  const previous = liveStart !== null && mayCarry
    ? read.data.candles.findLast(({ bucketStart }) => bucketStart < liveStart)
    : undefined;
  const carriedClose = previous && carryFrom !== null ? { timestampMs: carryFrom, price: previous.close } : undefined;
  const page = { ...read.data, candles };
  if (!candles.length && !carriedClose && read.state === "available") {
    return { name, section: { ...read, state: "empty" as const, data: page }, opening: undefined };
  }
  const opening = chartOpening(page, request, launch);
  const first = candles[0];
  if (!opening || !first) return { name, section: { ...read, data: page }, opening, carriedClose };

  // The first indexed trade can fall in a later bucket. Its pre-trade price is still the launch price.
  const { price } = opening;
  const candle = {
    ...first,
    open: price,
    high: comparePrices(price, first.high) > 0 ? price : first.high,
    low: comparePrices(price, first.low) < 0 ? price : first.low,
  };
  return { name, section: { ...read, data: { ...page, candles: [candle, ...candles.slice(1)] } }, opening, carriedClose };
}

export function ChartView(props: Parameters<typeof useChartViewControls>[0] & Readonly<{ compact?: boolean }>) {
  const view = useChartViewControls(props);
  const { source, venuePoolKey, quoteUsd, controls, updates, migration, selectable, drawn, shown, geometry, missingPriceUnits, latest, latestAvailable } = view;
  if (props.compact) return <CompactChart view={view} />;
  return (
    <div className={styles.chart}>
      <ChartControlsPanel view={view} />

      <ChartLegend view={view} />

      {selectable.length > 1 && selectable.every(({ name }) => !shown(name)) ? (
        <p className={styles.note}>No chart series selected.</p>
      ) : null}

      {geometry ? (
        <ChartFigure key={`${controls.range}:${controls.interval}`} quoteUsd={quoteUsd} drawn={drawn} migrationAt={migration?.timestampMs} venuePoolKey={venuePoolKey} geometry={geometry} latest={latest} latestAvailable={latestAvailable} source={source} controls={controls} />
      ) : null}

      {geometry && exactDecimal(quoteUsd) ? <p className={styles.note}>USD prices use the current {source.quoteSymbol} rate.</p> : null}
      {missingPriceUnits ? <p className={styles.note}>Price units couldn’t load.</p> : null}
      {/* The status region stays, empty and with no height, so a screen reader hears the note when it comes. */}
      <p className={styles.note} role="status">{updates}</p>

      <ChartSourcePages view={view} />
    </div>
  );
}

function ChartRangeFields({ view, compact = false }: Readonly<{ view: ReturnType<typeof useChartViewControls>; compact?: boolean }>) {
  const { controls, onControls } = view;
  return (
    <>
      <label className={styles.control} data-live-range={controls.range === "live" || undefined}>
        <span>Range</span>
        <SelectField size={compact ? "lg" : "md"} value={controls.range} onChange={(event) => {
          const range = event.target.value as ChartRange;
          onControls(range === "live" ? LIVE_CHART_CONTROLS : fitControls({ ...controls, range }));
        }}>
          {view.livePreset && <option value="live">Live · 5 min</option>}
          {CHART_RANGES.map((range) => (
            <option key={range} value={range}>{RANGE_LABEL[range]}</option>
          ))}
        </SelectField>
      </label>
      {controls.range !== "live" && <label className={styles.control}>
        <span>Interval</span>
        <SelectField size={compact ? "lg" : "md"} value={controls.interval} onChange={(event) => onControls({ ...controls, interval: event.target.value as ChartControls["interval"] })}>
          {rangeIntervals(controls.range).map((interval) => (
            <option key={interval} value={interval}>{interval}</option>
          ))}
        </SelectField>
      </label>}
    </>
  );
}

function ChartControlsPanel({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  const { onRefresh, pending } = view;
  return (
    <div className={styles.controls}>
      <ChartRangeFields view={view} />
      <Button size="xs" className={styles.refresh} onClick={onRefresh} disabled={pending} loading={pending} loadingLabel="Refreshing chart">Refresh chart</Button>
    </div>
  );
}

function ChartFilters({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  const { range, interval } = view.controls;
  // Opening focuses the card itself, which the browser does without scrolling; focusing its first field scrolled the page.
  const card = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger render={<DisclosureButton
        aria-label={range === "live" ? "Chart range: Live, last 5 minutes" : `Chart range and interval: ${RANGE_LABEL[range]} · ${interval}`}
        variant="ghost"
        size="md"
        className={styles.filterTrigger}
      >
        <span>{RANGE_LABEL[range]}{range !== "live" && <span className={styles.filterInterval} aria-hidden="true"> · {interval}</span>}</span>
      </DisclosureButton>} />
      <PopoverSurface
        positioner={{ align: "end", sideOffset: 8, collisionPadding: 12, className: styles.filterLayer }}
        popup={{ className: styles.filters, ref: card, initialFocus: card }}
      >
        <Popover.Title className={primitives.srOnly}>Chart filters</Popover.Title>
        <ChartRangeFields view={view} compact />
        <ChartLegend view={view} inFilters />
        <Popover.Close render={<Button size="sm" variant="ghost" className={styles.filterClose}>Close</Button>} />
      </PopoverSurface>
    </Popover.Root>
  );
}

function ChartSourcePages({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  const { sources, shown, label, source, quoteUsd, request, controls, updates } = view;
  return <>{sources.map(({ name, section }) => shown(name) ? <SourceCandles key={name} name={name} section={section} label={label(name)} source={source} quoteUsd={quoteUsd} request={request} range={controls.range} waiting={controls.range === "live" && updates !== null} /> : null)}</>;
}

function SourceCandles({ name, section, label, source, quoteUsd, request, range, waiting }: Readonly<{
  name: ChartSourceName;
  section: SourceState | null;
  label: string;
  source: ChartViewSource;
  quoteUsd?: string | null;
  request: ChartRequest;
  range: ChartRange;
  waiting: boolean;
}>) {
  const empty = name === "curve" ? "No bonding-curve trades in this range." : `No ${label} swaps in this range.`;
  return (
    <section className={styles.source} aria-label={`${label} candles`}>
      <h3 className={styles.sourceTitle}>{label}</h3>
      <DataState
        state={displayState(section, range)}
        subject={`${label} candles`}
        loading={`Loading ${label.toLowerCase()} candles…`}
        empty={waiting ? "Waiting for trade updates." : empty}
        recovery="Chart history refreshes automatically."
      >
        {(page) => {
          const note = limitedNote(page, request, range);
          return (
            <>
              {note ? <p className={styles.note}>{note}</p> : null}
              <CandleTable page={page} label={label} source={source} quoteUsd={quoteUsd} />
            </>
          );
        }}
      </DataState>
    </section>
  );
}

function ChartFigure({ drawn, migrationAt, venuePoolKey, geometry, latest, latestAvailable, source, controls, compact = false, traders = true, quoteUsd, candleTrade }: Readonly<{
  drawn: readonly DrawnSeries[];
  migrationAt?: number;
  venuePoolKey: string | null;
  geometry: NonNullable<ReturnType<typeof chartGeometry>>;
  latest: string | null;
  latestAvailable: boolean;
  source: ChartViewSource;
  controls: ChartControls;
  compact?: boolean;
  /** The compact chart's Traders switch: bubbles on the bars. */
  traders?: boolean;
  candleTrade?: ReturnType<typeof useCandleTrade>;
  quoteUsd?: string | null;
}>) {
  const deployer = useLaunchWallet();
  const activity = useWalletTrades();
  const liveTrade = useCandleTrade();
  const walletTrades = useMemo(() => chartWalletTrades(activity, deployer, source.curvePoolKey), [activity, deployer, source.curvePoolKey]);
  const venue = venuePoolKey?.split(":")[0];
  const graduation = venue ? `Graduated to ${venueName(venue)}` : "Graduated";
  const label = figureLabel(source, controls, geometry, { compact, quoteUsd, graduation, migrationAt });
  return (
    <figure className={styles.figure}>
      {compact ? null : <p className={styles.axis} aria-hidden="true">
        <>Last {tokenPrice(latestAvailable ? latest : null, source, quoteUsd)} · </>High {tokenPrice(geometry.highest, source, quoteUsd)} · Low {tokenPrice(geometry.lowest, source, quoteUsd)}
      </p>}
      <div className={compact ? styles.compactCanvas : styles.canvas}>
        {compact
          ? <KLineCoinChart sources={drawn} interval={controls.interval} memeDecimals={source.memeDecimals} quoteDecimals={source.quoteDecimals} quoteUsd={quoteUsd ?? null} quoteSymbol={source.quoteSymbol} latestAvailable={latestAvailable} label={label} traders={traders} trade={candleTrade} migrationAt={migrationAt} />
          : <PoolCandleChart latestAvailable={latestAvailable} walletTrades={walletTrades} ripple={walletRipple(walletTrades, liveTrade, controls.interval)} trade={candleTrade} label={label} compact={compact} rollingWindow={controls.range === "live"} memeDecimals={source.memeDecimals} quoteDecimals={source.quoteDecimals} quoteUsd={quoteUsd} sources={drawn} migrationAt={migrationAt} migrationLabel={venue ? <>Graduated to <DexIdentity venue={venue} /></> : graduation} quoteSymbol={source.quoteSymbol} from={geometry.start} to={geometry.end} />}
      </div>
    </figure>
  );
}

/** The tagged wallets' trades (deployer, top traders…) the chart marks, each on its own pool. */
function chartWalletTrades(activity: ReturnType<typeof useWalletTrades>, deployer: ReturnType<typeof useLaunchWallet>, curvePoolKey: string | null): WalletChartTrade[] {
  return activity.flatMap((row): WalletChartTrade[] => {
    const labels = tradeWalletLabels(row, deployer);
    if (!row.actor || !labels.length) return [];
    const trade = { cursor: row.position, address: row.actor, timestampMs: row.timestampMs, labels };
    switch (row.kind) {
      case "curve_buy":
      case "curve_sell":
        return curvePoolKey ? [{ ...trade, poolKey: curvePoolKey, side: row.kind === "curve_buy" ? "buy" : "sell" }] : [];
      case "venue_buy":
      case "venue_sell":
        return row.source ? [{ ...trade, poolKey: row.source, side: row.kind === "venue_buy" ? "buy" : "sell" }] : [];
      default:
        return [];
    }
  });
}

/** The figure's accessible name: what is plotted, over which range, and the graduation when it is in view. */
function figureLabel(source: ChartViewSource, controls: ChartControls, geometry: NonNullable<ReturnType<typeof chartGeometry>>, { compact, quoteUsd, graduation, migrationAt }: Readonly<{ compact: boolean; quoteUsd?: string | null; graduation: string; migrationAt?: number }>): string {
  const unit = exactDecimal(quoteUsd) ? "USD" : source.quoteSymbol;
  const metric = !compact ? `price in ${unit}` : `price in ${unit} and volume in ${source.quoteSymbol}`;
  const markerVisible = migrationAt !== undefined && migrationAt >= geometry.start && migrationAt <= geometry.end;
  const event = markerVisible ? ` ${graduation} on ${clock(migrationAt)}.` : "";
  return `${source.symbol} ${metric}. ${RANGE_WORDS[controls.range]}, ${controls.interval} intervals.${event}`;
}

function walletRipple(trades: readonly WalletChartTrade[], live: ReturnType<typeof useCandleTrade>, interval: ChartControls["interval"]): WalletRipple | null {
  if (!live) return null;
  const tagged = trades.find(row => row.cursor === live.trade.cursor && row.poolKey === live.poolKey && row.side === live.trade.side);
  if (!tagged) return null;
  return {
    cursor: tagged.cursor,
    receivedAt: live.receivedAt,
    markerKey: walletMarkerKey(tagged.poolKey, tagged.side, candleBucketStart(interval, tagged.timestampMs)),
  };
}

function ChartLegend({ view, inFilters = false }: Readonly<{ view: ReturnType<typeof useChartViewControls>; inFilters?: boolean }>) {
  const { selectable, shown, label, onToggle, migration, venuePoolKey } = view;
  const venue = venuePoolKey?.split(":")[0];
  if (selectable.length < 2 && (!migration || inFilters)) return null;
  return (
    <fieldset className={styles.legend} data-in-filters={inFilters || undefined}>
      <legend className={primitives.srOnly}>Chart series</legend>
      {selectable.length > 1 ? selectable.map(({ name }) => (
        <label key={name} className={styles.legendItem}>
          <Checkbox checked={shown(name)} onChange={(event) => onToggle(name, event.target.checked)} />
          {!inFilters && <span className={styles.swatch} data-source={name} aria-hidden="true" />}
          {name === "venue" && venue ? <DexIdentity venue={venue} /> : label(name)}
        </label>
      )) : null}
      {migration && !inFilters ? (
        <span className={styles.legendItem}>
          <span className={styles.swatch} data-marker="legend" aria-hidden="true" />
          Graduation
        </span>
      ) : null}
    </fieldset>
  );
}

type ChartViewControls = ReturnType<typeof useChartViewControls>;
/** The Traders switch: each trader's bubble on their bar, saved for the next chart. */
function useTradersShown() {
  const saved = useChartPreference("wallet-tags");
  const [chosen, setChosen] = useState<boolean>();
  return [chosen ?? saved !== "hidden", (shown: boolean) => {
    setChosen(shown);
    saveChartPreference("wallet-tags", shown ? "shown" : "hidden");
  }] as const;
}

/**
 * The coin page's chart: one row of controls (intervals, range, Traders) over the plot. A delayed
 * source's notice floats over the plot, so it never moves the page.
 */
function CompactChart({ view }: Readonly<{ view: ChartViewControls }>) {
  const [traders, setTraders] = useTradersShown();
  const allVenues = useContext(ChartPeopleTrades) !== null;
  const { source, quoteUsd, geometry } = view;
  const unit = geometry && (exactDecimal(quoteUsd) ? "USD" : source.quoteSymbol);
  return <div className={styles.chart} data-compact-chart="">
    <div className={styles.compactHead}>
      <h2>Price{unit ? <span> · {unit}</span> : null}</h2>
      <StreamNotice view={view} />
      <div className={styles.compactTools}>
        {view.controls.range !== "live" && <IntervalButtons view={view} />}
        <ChartFilters view={view} />
        {/* Held while the bars load, so the row never shifts when they arrive. */}
        {(geometry || loadingBars(view)) && <label className={styles.tradersToggle}>
          {allVenues ? "Traders (all venues)" : "Traders"}
          <Switch checked={traders} onCheckedChange={setTraders} />
        </label>}
      </div>
    </div>
    <ChartLastTrade />
    <div className={styles.plotFrame}>
      <div className={styles.plotStage}>
        <CompactChartBody view={view} traders={traders} />
        <CompactStatus view={view} />
      </div>
      {view.geometry && <CompactSourceNotices view={view} />}
    </div>
  </div>;
}

/** On a chart wider than about 640 px, the range's intervals as one row of buttons: one tap changes the candles. Narrower charts keep them in the range picker. */
function IntervalButtons({ view }: Readonly<{ view: ChartViewControls }>) {
  const { controls, onControls } = view;
  return <span className={styles.intervalPicker}>
    <Segmented label="Candle interval" size="touch" variant="outline" options={rangeIntervals(controls.range).map((interval) => [interval, interval] as const)} value={controls.interval} onChange={(interval) => onControls({ ...controls, interval })} />
  </span>;
}

/** The live stream's state ("Trade updates delayed." while the tab's socket is refused or reconnecting); an empty Live chart says it in its own empty state instead. */
function streamNotice({ geometry, updates, controls }: ChartViewControls) {
  return geometry || controls.range !== "live" ? updates : null;
}

/**
 * The stream's state in the chart's head, where the eye already is, on one line in the room the
 * title and tools leave. A narrow chart has no such room, so its status slot says it instead.
 */
function StreamNotice({ view }: Readonly<{ view: ChartViewControls }>) {
  return <p className={`${styles.note} ${styles.headNotice}`} role="status" data-stream-notice="">{streamNotice(view)}</p>;
}

/**
 * A source's delayed notice with its Try again (and on a narrow chart the stream's), on a card
 * over the plot's foot, just above the time axis; the notes under the plot sit outside its box. The status region stays while the card comes and goes.
 */
function CompactStatus({ view }: Readonly<{ view: ChartViewControls }>) {
  const alert = view.geometry ? compactSourceAlert(view) : null;
  const notice = streamNotice(view);
  return <div className={styles.alertSlot} role="status">
    {alert ? <p className={`${styles.note} ${styles.alertCard}`}>{alert}</p>
      : notice ? <p className={`${styles.note} ${styles.alertCard} ${styles.slotNotice}`}>{notice}</p> : null}
  </div>;
}

function CompactChartBody({ view, traders }: Readonly<{ view: ChartViewControls; traders: boolean }>) {
  const { source, quoteUsd, controls, migration, venuePoolKey, drawn, geometry, latest, latestAvailable } = view;
  const candleTrade = useCandleTrade();
  if (!geometry) return <CompactEmptyChart view={view} />;
  return <ChartFigure compact candleTrade={candleTrade} traders={traders} quoteUsd={quoteUsd} drawn={drawn} migrationAt={migration?.timestampMs} venuePoolKey={venuePoolKey} geometry={geometry} latest={latest} latestAvailable={latestAvailable} source={source} controls={controls} />;
}

function CompactEmptyChart({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  const { amountsHidden } = useShellPrefs();
  const opening = compactOpeningPrice(view);
  const visible = view.sources.filter(({ name }) => view.shown(name));
  const state = `${klineStyles.sized} ${styles.chartEmpty}`;
  if (opening) return <EmptyState className={state} title={`Opening price ${amountsHidden ? HIDDEN_AMOUNT : tokenPrice(opening, view.source, view.quoteUsd)}`}>The chart starts with the first trade.</EmptyState>;
  if (view.missingPriceUnits) return <EmptyState className={state} role="alert" title="Price units couldn’t load.">Reload the page to try again.</EmptyState>;
  if (!visible.length) return <EmptyState className={state} title="No chart series selected.">Open chart filters to show a series.</EmptyState>;
  if (loadingBars(view)) return (
    <SkeletonRegion label="Loading price history">
      <SkeletonBox className={`${klineStyles.loading} ${styles.chartSkeleton}`} />
    </SkeletonRegion>
  );
  const delayed = visible.some(({ section }) => section?.state === "stale");
  if (delayed || visible.some(({ section }) => section?.state === "unavailable" || section === null)) return (
    <EmptyState className={state} role="alert" title={delayed ? "Price history is delayed." : PRICE_HISTORY_UNAVAILABLE} action={
      <Button className={styles.chartRetry} onClick={view.onRefresh} loading={view.pending} loadingLabel="Refreshing price history">Try again</Button>
    }>
      {view.diagnostic && <DiagnosticCode message={view.diagnostic} generic={PRICE_HISTORY_UNAVAILABLE} />}
    </EmptyState>
  );
  if (view.emptyMessage) return <EmptyState className={state} title={view.emptyMessage} />;
  if (view.controls.range === "live" && view.updates) {
    return <EmptyState className={state} role="status" title={view.updates}>The chart refreshes automatically.</EmptyState>;
  }
  return view.controls.range === "all"
    ? <EmptyState className={state} title="No price history yet" />
    : <EmptyState className={state} title="No trades in this range">Choose a wider range to see more trades.</EmptyState>;
}

const loadingBars = (view: ChartViewControls) => view.sources.some(({ name, section }) => view.shown(name) && section?.state === "loading");

function compactOpeningPrice({ migration, hasPriceUnits, source, controls, shown, sources }: ReturnType<typeof useChartViewControls>) {
  if (migration || !hasPriceUnits || controls.range !== "all" || !shown("curve") || sources[0]?.section?.state !== "empty") return null;
  return source.opening?.price ?? null;
}

const LAST_UPDATE_TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const LAST_UPDATE_DAY_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The first source whose history is delayed or failed, with its Try again; null when every source is current. */
function compactSourceAlert(view: ReturnType<typeof useChartViewControls>) {
  const alert = view.sources.find(({ section }) => isBehind(section));
  if (!alert) return null;
  // The last checkpoint the delayed source answered for, so the trader knows how old its prices are.
  const asOf = alert.section && "provenance" in alert.section ? alert.section.provenance?.timestampMs : null;
  const today = asOf ? new Date(asOf).toDateString() === new Date().toDateString() : true;
  const since = asOf ? ` Last update ${(today ? LAST_UPDATE_TIME : LAST_UPDATE_DAY_TIME).format(asOf)}.` : "";
  const problem = alert.section?.state === "stale" ? "price updates delayed." : "price history couldn’t load.";
  return <>
    {`${view.label(alert.name)} ${problem}${since}`}{" "}
    <Button size="sm" variant="ghost" disabled={view.pending} onClick={view.onRefresh}>Try again</Button>
    {view.diagnostic && <DiagnosticCode message={view.diagnostic} generic={PRICE_HISTORY_UNAVAILABLE} />}
  </>;
}

const noTrades = (page: ChartCandlePage) => page.candles.every((candle) => candle.volumeQuote === 0n);

function CompactSourceNotices({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  // A quiet Live window draws the last price carried in from before it: say so, so flat bars never read as trades.
  // A delayed source cannot say there were no trades, so its own alert speaks instead.
  const quiet = view.controls.range === "live" && !view.sources.some(({ section }) => isBehind(section)) && view.drawn.every(({ page }) => noTrades(page));
  if (quiet) return <p className={styles.note}>No trades in the last 5 min. The bars hold the last traded price.</p>;
  return <>{view.sources.map(({ name, section }) => {
    if (!hasData(section)) return null;
    const note = limitedNote(section.data, view.request, view.controls.range);
    return note ? <p className={styles.note} key={name}>{view.label(name)}: {note}</p> : null;
  })}</>;
}
