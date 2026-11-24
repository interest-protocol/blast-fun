import { ChartLastTrade } from "./ChartLastTrade.tsx";
import { useCandleTrade } from "./chart-trade-context.ts";
import { PoolCandleChart } from "#web/components/charts/PoolCandleChart.tsx";
import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { poolPrices } from "#web/components/charts/candle-data.ts";
import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { ChartCandlesIcon, ChartLineIcon } from "#web/components/blast-ui/Icons.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { useLaunchWallet, useWalletTrades } from "../activity/wallet-trades";
import { tradeWalletLabels } from "../activity/wallet-labels";
import { liveWalletMarkerKey, walletMarkerKey, type WalletChartTrade, type WalletRipple } from "#web/components/charts/wallet-markers.ts";
import { useMemo, useState } from "react";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useMobileChartLayout } from "#web/components/charts/use-mobile-chart-layout.ts";
import { saveChartPreference, useChartPreference } from "./chart-preferences";

import { candleBucketStart, candleIntervalMs, comparePrices } from "@blast/core/modules/launchpad-contract/venue-history.ts";
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
import { ChartPreview } from "./ChartPreview";
import { CHART_INTERVALS, LIVE_CHART_INTERVALS, CHART_RANGES, LIVE_CHART_CONTROLS, LIVE_CHART_SPAN_MS, candleGaps, chartLatestTimestamp, chartOpening, chartSources, pageTruncated, type ChartCandlePage, type ChartControls, type ChartRange, type ChartRequest, type ChartState, type CandleGap, type SourceState } from "./chart-model";
import { useChartClock } from "./use-chart-clock.ts";
import styles from "./Chart.module.css";
import { HIDDEN_AMOUNT, NO_VALUE, venueName } from "@blast/core/lib/format.ts";

export const PRICE_HISTORY_UNAVAILABLE = "Price history couldn’t load.";

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

/** Says when a page may leave older candles unread: only a full page of a capped read. */
function limitedNote(page: ChartCandlePage, request: ChartRequest, range: ChartRange): string | null {
  if (!pageTruncated(page, request)) return null;
  const count = `${page.candles.length.toLocaleString("en-US")} candle${page.candles.length === 1 ? "" : "s"}`;
  return range === "all"
    ? `Newest ${count} · older history not loaded.`
    : `Newest ${count} in range · older history not loaded.`;
}

/**
 * Each pool keeps its own candles and gap records around the committed migration.
 * Live plots the original execution timestamps.
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
  marketChart = false,
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
  marketChart?: boolean;
  onControls: (controls: ChartControls) => void;
  onToggle: (source: ChartSourceName, shown: boolean) => void;
  onRefresh: () => void;
}>) {
  const live = controls.range === "live";
  const now = useChartClock(1_000, live);
  const drawing = chartDrawing({ state, source, omitCurve, historyRequest, hidden, live, now, marketChart, currentPrice });
  const delayed = live && drawing.sources.some(({ section }) => !section || section.state === "stale" || section.state === "unavailable");
  return { source, quoteUsd, controls, pending, updates: updates ?? (delayed ? "Trade updates delayed." : null), emptyMessage, livePreset, diagnostic, marketChart, onControls, onToggle, onRefresh, ...drawing };
}

function chartDrawing({ state, source, omitCurve, historyRequest, hidden, live, now, marketChart, currentPrice }: Readonly<{
  state: ChartState;
  source: ChartViewSource;
  omitCurve?: boolean;
  historyRequest: ChartRequest;
  hidden: readonly ChartSourceName[];
  live: boolean;
  now: number | null;
  currentPrice?: string | null;
  marketChart: boolean;
}>) {
  const chainTime = chartLatestTimestamp(state);
  const liveEnd = live ? Math.max(now ?? 0, chainTime) : null;
  const liveStart = liveEnd === null ? null : liveEnd - LIVE_CHART_SPAN_MS;
  const launchAt = source.launchAt ?? source.opening?.timestampMs;
  const { request, sinceLaunch, start, end } = chartViewport(historyRequest, marketChart, liveStart, liveEnd, launchAt, chainTime);
  const migration = state.migration;
  const venuePoolKey = source.venuePoolKey ?? migration?.venuePoolKey ?? null;
  const sources = chartSources(state)
    .filter(({ name }) => name !== "curve" || (!omitCurve && source.curvePoolKey !== null))
    .map((read) => priceSource(read, request, liveStart, liveEnd, marketChart ? undefined : source.opening));
  const label = (name: ChartSourceName) => sourceLabel(name, venuePoolKey);
  const selectable = sources.filter(({ section }) => hasData(section) && section.data.candles.length > 0);
  const shown = (name: ChartSourceName) =>
    (selectable.length === 1 && selectable[0]?.name === name) || !hidden.includes(name);
  const drawn: DrawnSeries[] = sources.flatMap(({ name, section, opening, lastTrade, liveTrades }) =>
    hasData(section) && section.data.candles.length && shown(name) ? [{
      source: name, page: section.data, opening, liveTrades, lastTrade, observedAt: section.provenance.timestampMs,
    }] : [],
  );
  const visible = sources.filter(({ name }) => shown(name));
  const lastTrade = visible.flatMap(source => source.lastTrade ? [source.lastTrade] : [])
    .reduce<(typeof drawn)[number]["lastTrade"]>((latest, trade) => !latest || trade.timestampMs >= latest.timestampMs ? trade : latest, undefined);
  const gapStatus = marketChart && !live ? chartGapStatus(visible, request, launchAt, migration?.timestampMs, chainTime) : undefined;
  const partial = marketChart && !live && partialHistory(visible, request, launchAt, drawn.length > 0);
  const liveIncomplete = liveStart !== null && visible.some(({ liveTapeStart }) => liveTapeStart !== undefined && liveTapeStart >= liveStart);
  const hasLiveTrades = visible.some(({ inWindow }) => inWindow);
  const latest = drawn.at(-1);
  const close = latest?.page.candles.at(-1)?.close ?? null;
  const hasLatest = latest !== undefined &&
    sources.find(({ name }) => name === latest.source)?.section?.state === "available" &&
    (currentPrice === undefined || (currentPrice === close && latest.source === (venuePoolKey ? "venue" : "curve")));
  const hasPriceUnits = source.memeDecimals !== null && source.quoteDecimals !== null;
  const geometry = hasPriceUnits ? chartGeometry(drawn, migration, start, end) : null;
  const missingPriceUnits = Boolean(latest) && !hasPriceUnits;
  return { venuePoolKey, request, migration, sources, selectable, drawn, label, shown, geometry, hasPriceUnits, missingPriceUnits,
    sinceLaunch, lastTrade, hasLiveTrades, liveIncomplete, gapStatus, partial, latestAvailable: hasLatest, latest: close };
}

function chartViewport(history: ChartRequest, marketChart: boolean, liveStart: number | null, liveEnd: number | null, launchAt: number | undefined, chainTime: number) {
  if (liveStart !== null) return { request: { ...history, from: liveStart }, sinceLaunch: false, start: liveStart, end: liveEnd };
  const sinceLaunch = marketChart && launchAt !== undefined && (history.from === undefined || history.from < launchAt);
  const from = sinceLaunch ? candleBucketStart(history.interval, launchAt) : history.from;
  if (history.from === undefined) return { request: { ...history, from }, sinceLaunch, start: undefined, end: null };
  return { request: { ...history, from }, sinceLaunch, start: from, end: chainTime || null };
}

type PriceSource = ReturnType<typeof priceSource>;

function chartGapStatus(sources: PriceSource[], request: ChartRequest, launchAt: number | undefined, migrationAt: number | undefined, chainTime: number) {
  const coverage = sources.flatMap(({ name, section }) => {
    const from = name === "curve" ? launchAt : migrationAt;
    const observed = section && "provenance" in section ? section.provenance?.timestampMs : undefined;
    if (from === undefined || observed == null || !section || !["available", "stale", "empty"].includes(section.state)) return [];
    const data = hasData(section) ? section.data : undefined;
    const first = data?.candles[0]?.bucketStart;
    const floor = first !== undefined && data && pageTruncated(data, request) ? Math.max(from, first) : from;
    return [{ from: floor, to: name === "curve" ? Math.min(observed, migrationAt ?? Infinity) : observed }];
  });
  const interval = candleIntervalMs(request.interval);
  return (at: number) => {
    const start = Math.max(at, launchAt ?? at);
    const end = Math.min(at + interval, chainTime);
    if (start >= end) return "History unavailable";
    const split = migrationAt;
    const covered = split !== undefined && split > start && split < end
      ? coverage.some(span => span.from <= start && span.to >= split) && coverage.some(span => span.from <= split && span.to >= end)
      : coverage.some(span => span.from <= start && span.to >= end);
    return covered ? "No trades" : "History unavailable";
  };
}

function partialHistory(sources: PriceSource[], request: ChartRequest, launchAt: number | undefined, hasDrawing: boolean) {
  return launchAt === undefined || sources.some(({ section }) =>
    !section || section.state === "unavailable" || section.state === "stale" || hasData(section) && pageTruncated(section.data, request) ||
    hasDrawing && section.state === "loading");
}

function priceSource(
  { name, section: read }: ReturnType<typeof chartSources>[number],
  request: ChartRequest,
  liveStart: number | null,
  liveEnd: number | null,
  launch: ChartViewSource["opening"],
) {
  if (!hasData(read)) return { name, section: read };
  if (liveStart !== null && liveEnd !== null) {
    const tape = read.data.liveTrades ?? [];
    const executions = tape.filter(trade => trade.kind !== "opening_round_fill");
    const inWindow = executions.filter(({ timestampMs }) => timestampMs >= liveStart && timestampMs <= liveEnd);
    const liveTrades = inWindow.filter(trade => trade.price !== null);
    const lastTrade = executions.at(-1);
    const buckets = new Set(liveTrades.map(trade => candleBucketStart("1s", trade.timestampMs)));
    const candles = read.data.candles.filter(({ bucketStart }) => buckets.has(bucketStart));
    return { name, section: { ...read, data: { ...read.data, candles } }, liveTrades, lastTrade, inWindow: inWindow.length > 0,
      liveTapeStart: read.data.truncated ? tape[0]?.timestampMs : undefined };
  }
  const { from } = request;
  const candles = from === undefined ? read.data.candles : read.data.candles.filter(candle => candle.bucketStart >= from);
  const page = { ...read.data, candles };
  if (!candles.length && read.state === "available") return { name, section: { ...read, state: "empty" as const, data: page } };
  const opening = chartOpening(page, request, launch);
  const first = candles[0];
  if (!opening || !first) return { name, section: { ...read, data: page }, opening };
  const { price } = opening;
  const candle = {
    ...first,
    open: price,
    high: comparePrices(price, first.high) > 0 ? price : first.high,
    low: comparePrices(price, first.low) < 0 ? price : first.low,
  };
  return { name, section: { ...read, data: { ...read.data, candles: [candle, ...candles.slice(1)] } }, opening };
}

export function ChartView(props: Parameters<typeof useChartViewControls>[0] & Readonly<{ compact?: boolean; preview?: boolean }>) {
  const view = useChartViewControls(props);
  const { source, venuePoolKey, quoteUsd, controls, updates, migration, selectable, drawn, shown, geometry, missingPriceUnits, latest, latestAvailable } = view;
  if (props.compact) return <CompactChart view={view} preview={props.preview} />;
  return (
    <div className={styles.chart}>
      <ChartControlsPanel view={view} />

      <ChartLegend view={view} />

      {selectable.length > 1 && selectable.every(({ name }) => !shown(name)) ? (
        <p className={styles.note}>No chart series selected.</p>
      ) : null}

      {geometry ? (
        <ChartFigure key={`${controls.range}:${controls.interval}`} presentation={controls.range === "live" ? "line" : undefined} marketChart={view.marketChart} discontinuous={view.partial} gapStatus={view.gapStatus} quoteUsd={quoteUsd} drawn={drawn} migrationAt={migration?.timestampMs} venuePoolKey={venuePoolKey} geometry={geometry} latest={latest} latestAvailable={latestAvailable} source={source} controls={controls} />
      ) : null}

      <ChartHistoryStatus view={view} />
      <LiveTradeStatus view={view} />
      {geometry && exactDecimal(quoteUsd) ? <p className={styles.note}>USD prices use the current {source.quoteSymbol} rate.</p> : null}
      {missingPriceUnits ? <p className={styles.note}>Price units couldn’t load.</p> : null}
      {updates && controls.range !== "live" ? <p className={styles.note} role="status">{updates}</p> : null}

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
          onControls(range === "live" ? LIVE_CHART_CONTROLS : { ...controls, range });
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
          {(view.source.curvePoolKey === null ? CHART_INTERVALS : LIVE_CHART_INTERVALS).map((interval) => (
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

const CHART_STYLES = [
  ["candles", <><ChartCandlesIcon /><span className={primitives.srOnly}>Candles &amp; volume</span></>],
  ["line", <><ChartLineIcon /><span className={primitives.srOnly}>Line chart</span></>],
] as const;

function ChartFilters({ view, style }: Readonly<{ view: ReturnType<typeof useChartViewControls>; style: "line" | "candles" }>) {
  const { range, interval } = view.controls;
  return (
    <Popover.Root>
      <Popover.Trigger render={<DisclosureButton
        aria-label={range === "live" ? "Chart range: Live, last 5 minutes" : `Chart range and interval: ${RANGE_LABEL[range]} · ${interval}`}
        variant="ghost"
        size="md"
        className={styles.filterTrigger}
      >
        <span>{RANGE_LABEL[range]}{range !== "live" && <span className={styles.filterInterval} data-line-interval={style === "line" || undefined} aria-hidden="true"> · {interval}</span>}</span>
      </DisclosureButton>} />
      <PopoverSurface
        positioner={{ align: "end", sideOffset: 8, collisionPadding: 12, className: styles.filterLayer }}
        popup={{ className: styles.filters }}
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

function ChartFigure({ drawn, migrationAt, venuePoolKey, geometry, latest, latestAvailable, source, controls, compact = false, presentation, quoteUsd, candleTrade, preview, marketChart, discontinuous, gapStatus }: Readonly<{
  drawn: readonly DrawnSeries[];
  migrationAt?: number;
  venuePoolKey: string | null;
  geometry: NonNullable<ReturnType<typeof chartGeometry>>;
  latest: string | null;
  latestAvailable: boolean;
  source: ChartViewSource;
  controls: ChartControls;
  compact?: boolean;
  presentation?: "line" | "candles";
  candleTrade?: ReturnType<typeof useCandleTrade>;
  quoteUsd?: string | null;
  preview?: boolean;
  marketChart?: boolean;
  gapStatus?: (at: number) => string;
  discontinuous?: boolean;
}>) {
  const deployer = useLaunchWallet();
  const activity = useWalletTrades();
  const liveTrade = useCandleTrade();
  const walletTrades = useMemo(() => activity.flatMap((row): WalletChartTrade[] => {
    const labels = tradeWalletLabels(row, deployer);
    if (!row.actor || !labels.length) return [];
    const trade = { cursor: row.position, address: row.actor, timestampMs: row.timestampMs, labels };
    switch (row.kind) {
      case "curve_buy":
      case "curve_sell":
        return source.curvePoolKey ? [{ ...trade, poolKey: source.curvePoolKey, side: row.kind === "curve_buy" ? "buy" : "sell" }] : [];
      case "venue_buy":
      case "venue_sell":
        return row.source ? [{ ...trade, poolKey: row.source, side: row.kind === "venue_buy" ? "buy" : "sell" }] : [];
      default:
        return [];
    }
  }), [activity, deployer, source.curvePoolKey]);
  const ripple = walletRipple(walletTrades, liveTrade, controls);
  const line = presentation === "line";
  const unit = exactDecimal(quoteUsd) ? "USD" : source.quoteSymbol;
  const metric = line || !compact ? `price in ${unit}` : `price in ${unit} and volume in ${source.quoteSymbol}`;
  const venue = venuePoolKey?.split(":")[0];
  const graduation = venue ? `Graduated to ${venueName(venue)}` : "Graduated";
  const markerVisible = migrationAt !== undefined && migrationAt >= geometry.start && migrationAt <= geometry.end;
  const event = markerVisible ? ` ${graduation} on ${clock(migrationAt)}.` : "";
  const label = `${source.symbol} ${metric}. ${RANGE_WORDS[controls.range]}, ${controls.interval} intervals.${event}`;
  const initialPlot = preview && controls.range !== "live"
    ? <CoinChartPreview geometry={geometry} sources={drawn} migrationAt={migrationAt} line={line} marketChart={marketChart} />
    : null;
  return (
    <figure className={styles.figure}>
      {compact ? null : <p className={styles.axis} aria-hidden="true">
        <>Last {tokenPrice(latestAvailable ? latest : null, source, quoteUsd)} · </>High {tokenPrice(geometry.highest, source, quoteUsd)} · Low {tokenPrice(geometry.lowest, source, quoteUsd)}
      </p>}
      <div className={compact ? styles.compactCanvas : styles.canvas}>
        <PoolCandleChart latestAvailable={latestAvailable} walletTrades={walletTrades} ripple={ripple} trade={candleTrade} label={label} compact={compact} marketChart={marketChart} discontinuous={discontinuous} gapStatus={gapStatus} rollingWindow={controls.range === "live"} presentation={presentation} memeDecimals={source.memeDecimals} quoteDecimals={source.quoteDecimals} quoteUsd={quoteUsd} sources={drawn} migrationAt={migrationAt} migrationLabel={venue ? <>Graduated to <DexIdentity venue={venue} /></> : graduation} quoteSymbol={source.quoteSymbol} from={geometry.start} to={geometry.end} preview={initialPlot} />
      </div>
    </figure>
  );
}

function CoinChartPreview({ marketChart, line, ...plot }: Parameters<typeof ChartPreview>[0] & { marketChart?: boolean }) {
  if (marketChart || line) return <ChartPreview {...plot} line={line} />;
  return <>
    <ChartPreview {...plot} line={false} viewport="desktop" />
    <ChartPreview {...plot} line viewport="mobile" />
  </>;
}

function walletRipple(trades: readonly WalletChartTrade[], live: ReturnType<typeof useCandleTrade>, controls: ChartControls): WalletRipple | null {
  if (!live) return null;
  const tagged = trades.find(row => row.cursor === live.trade.cursor && row.poolKey === live.poolKey && row.side === live.trade.side);
  if (!tagged) return null;
  return {
    cursor: tagged.cursor,
    receivedAt: live.receivedAt,
    markerKey: controls.range === "live" ? liveWalletMarkerKey(tagged) : walletMarkerKey(tagged.poolKey, tagged.side, candleBucketStart(controls.interval, tagged.timestampMs)),
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
type ChartStyle = "line" | "candles";

function useChartStyle() {
  const saved = useChartPreference("style");
  const [selected, setStyle] = useState<ChartStyle | null>(null);
  const preferred = saved === "line" ? "line" : "candles";
  return [selected ?? preferred, (next: ChartStyle) => {
    saveChartPreference("style", next);
    setStyle(next);
  }] as const;
}

function CompactChart({ view, preview }: Readonly<{ view: ChartViewControls; preview?: boolean }>) {
  const mobile = useMobileChartLayout();
  const [preferredStyle, setStyle] = useChartStyle();
  const live = view.controls.range === "live";
  const style = (mobile && !view.marketChart) || live ? "line" : preferredStyle;
  const { source, quoteUsd } = view;
  return <div className={styles.chart} data-compact-chart="" data-chart-style={style} data-market-chart={view.marketChart || undefined}>
    <CompactChartHeader view={view} style={style} mobile={mobile} onStyle={setStyle} />
    {!live && <ChartLastTrade />}
    <ChartHistoryStatus view={view} />
    <LiveTradeStatus view={view} />
    <CompactChartBody view={view} style={style} preview={preview} />
    {view.marketChart && exactDecimal(quoteUsd) && <p className={styles.note}>USD prices use the current {source.quoteSymbol} rate.</p>}
    {view.updates && !live && <p className={styles.note} role="status">{view.updates}</p>}
  </div>;
}

function CompactChartHeader({ view, style, mobile, onStyle }: Readonly<{ view: ChartViewControls; style: ChartStyle; mobile: boolean; onStyle: (style: ChartStyle) => void }>) {
  const { source, quoteUsd, geometry } = view;
  const unit = geometry && (exactDecimal(quoteUsd) ? "USD" : source.quoteSymbol);
  const showStyle = geometry && view.controls.range !== "live" && (!mobile || view.marketChart);
  return (
    <div className={styles.compactHead}>
      <h2>Price{unit ? <span> · {unit}</span> : null}</h2>
      <div className={styles.compactTools}>
        {showStyle && <Segmented className={styles.stylePicker} label="Chart style" size="touch" variant="outline" options={CHART_STYLES} value={style} onChange={onStyle} />}
        <ChartFilters view={view} style={style} />
      </div>
    </div>
  );
}

function CompactChartBody({ view, style, preview }: Readonly<{ view: ChartViewControls; style: ChartStyle; preview?: boolean }>) {
  const { source, quoteUsd, controls, migration, venuePoolKey, drawn, geometry, latest, latestAvailable } = view;
  const candleTrade = useCandleTrade();
  if (!geometry) return <CompactEmptyChart view={view} />;
  return <>
    <ChartFigure compact marketChart={view.marketChart} discontinuous={view.partial} gapStatus={view.gapStatus} candleTrade={controls.range === "live" ? undefined : candleTrade} presentation={style} quoteUsd={quoteUsd} drawn={drawn} migrationAt={migration?.timestampMs} venuePoolKey={venuePoolKey} geometry={geometry} latest={latest} latestAvailable={latestAvailable} source={source} controls={controls} preview={preview} />
    {controls.range !== "live" && <CompactSourceNotices view={view} />}
  </>;
}

function ChartHistoryStatus({ view }: Readonly<{ view: ChartViewControls }>) {
  if (!view.sinceLaunch && !view.partial) return null;
  return <p className={styles.note}>{[view.sinceLaunch && "Since launch", view.partial && "Partial price history"].filter(Boolean).join(" · ")}</p>;
}

function LiveTradeStatus({ view }: Readonly<{ view: ChartViewControls }>) {
  const { amountsHidden } = useShellPrefs();
  if (view.controls.range !== "live") return null;
  const { lastTrade, source, quoteUsd, updates, liveIncomplete } = view;
  const at = lastTrade && new Date(lastTrade.timestampMs).toISOString();
  return <>
    {lastTrade && at && <p className={styles.note}>
      {lastTrade.price === null ? "Last trade · price unavailable" : `Last traded price ${amountsHidden ? HIDDEN_AMOUNT : tokenPrice(lastTrade.price, source, quoteUsd)}`}
      {" · "}<time dateTime={at}>{at.slice(0, 10)} · {at.slice(11, 19)} UTC</time>
    </p>}
    {updates && <p className={styles.note} role="status">{updates}</p>}
    {liveIncomplete && <p className={styles.note} role="status">Partial trade history in this window.</p>}
  </>;
}

function CompactEmptyChart({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  const { amountsHidden } = useShellPrefs();
  const opening = compactOpeningPrice(view);
  const visible = view.sources.filter(({ name }) => view.shown(name));
  const state = `${styles.chartState} ${styles.chartEmpty}`;
  if (opening) return <EmptyState className={state} title={`Opening price ${amountsHidden ? HIDDEN_AMOUNT : tokenPrice(opening, view.source, view.quoteUsd)}`}>The chart starts with the first trade.</EmptyState>;
  if (view.missingPriceUnits) return <EmptyState className={state} role="alert" title="Price units couldn’t load.">Reload the page to try again.</EmptyState>;
  if (!visible.length) return <EmptyState className={state} title="No chart series selected.">Open chart filters to show a series.</EmptyState>;
  if (visible.some(({ section }) => section?.state === "loading")) return (
    <SkeletonRegion className={styles.chartState} label="Loading price history">
      <SkeletonBox className={styles.chartSkeleton} />
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
  if (view.controls.range === "live") {
    return <EmptyState className={state} title={quietLiveTitle(view)} />;
  }
  return view.controls.range === "all"
    ? <EmptyState className={state} title="No price history yet" />
    : <EmptyState className={state} title="No trades in this range">Choose a wider range to see more trades.</EmptyState>;
}

function quietLiveTitle(view: ChartViewControls) {
  if (view.updates || view.liveIncomplete) return "Waiting for trade updates";
  return view.hasLiveTrades ? "Trade prices unavailable in this window" : "No trades in the last 5 min";
}

function compactOpeningPrice({ migration, hasPriceUnits, source, controls, shown, sources }: ReturnType<typeof useChartViewControls>) {
  if (migration || !hasPriceUnits || controls.range !== "all" || !shown("curve") || sources[0]?.section?.state !== "empty") return null;
  return source.opening?.price ?? null;
}

function CompactSourceNotices({ view }: Readonly<{ view: ReturnType<typeof useChartViewControls> }>) {
  return <>{view.sources.map(({ name, section }) => {
    if (section?.state === "unavailable" || section?.state === "stale") return (
      <div key={name} className={styles.note} role="status">
        {section.state === "stale" ? `${view.label(name)} price updates delayed.` : `${view.label(name)} price history couldn’t load.`}{" "}
        <Button size="sm" variant="ghost" disabled={view.pending} onClick={view.onRefresh}>Try again</Button>
        {view.diagnostic && <DiagnosticCode message={view.diagnostic} generic={PRICE_HISTORY_UNAVAILABLE} />}
      </div>
    );
    if (!hasData(section)) return null;
    const note = limitedNote(section.data, view.request, view.controls.range);
    return note ? <p className={styles.note} key={name}>{view.label(name)}: {note}</p> : null;
  })}</>;
}
