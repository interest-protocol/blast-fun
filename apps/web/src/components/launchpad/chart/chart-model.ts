// The coin chart's state: each source pool's own candles as blast-infra
// serves them (`/v1/pools/{venue}/{pool_id}/candles`), the committed
// migration between them, and the controls a direct link carries. Nothing
// here makes a candle, fills a gap or moves the migration: missing intervals
// stay missing, and the raw OHLC and volume are the engine's.

import { CANDLE_PAGE, candleBucketStart, candleIntervalMs, type Candle, type CandleInterval, type CandleRequest, type MigratedChart, type MigrationMarker, type PoolCandlePage, type PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";

/** History-only controls retained for existing callers; streaming controls also expose 1s. */
export const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const satisfies readonly CandleInterval[];
export const LIVE_CHART_INTERVALS = ["1s", ...CHART_INTERVALS] as const;
export type ChartInterval = (typeof LIVE_CHART_INTERVALS)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LIVE_CHART_SPAN_MS = 5 * 60_000;
/** How far back each range reaches; `all` is the newest page with no lower bound. */
const RANGE_MS = { "1h": HOUR, "6h": 6 * HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, all: null } as const;
type HistoryRange = keyof typeof RANGE_MS;
export type ChartRange = HistoryRange | "live";
export const CHART_RANGES = Object.keys(RANGE_MS) as HistoryRange[];

export type ChartControls = Readonly<{ interval: ChartInterval; range: ChartRange }>;
export const DEFAULT_CHART_CONTROLS = { interval: "5m", range: "all" } as const satisfies ChartControls;
const RANGE_INTERVALS = { "1h": "1m", "6h": "5m", "24h": "15m", "7d": "1h", "30d": "4h", all: "5m", live: "1s" } as const satisfies Record<ChartRange, ChartInterval>;

/** A bounded range shows at least this many buckets. */
const MIN_RANGE_BUCKETS = 12;

export function rangeInterval(range: ChartRange): ChartInterval {
  return RANGE_INTERVALS[range];
}

/**
 * The intervals a range can show: Live is 1s; a bounded range splits into at least
 * `MIN_RANGE_BUCKETS` and at most one page of candles (1H/1d would be one bar);
 * all history takes any history interval.
 */
export function rangeIntervals(range: ChartRange): readonly ChartInterval[] {
  if (range === "live") return ["1s"];
  const span = RANGE_MS[range];
  if (span === null) return CHART_INTERVALS;
  return CHART_INTERVALS.filter((interval) => {
    const buckets = span / candleIntervalMs(interval);
    return buckets >= MIN_RANGE_BUCKETS && buckets <= CANDLE_PAGE.max;
  });
}

/** The controls with an interval their range can show; another interval becomes the range's default. */
export function fitControls(controls: ChartControls): ChartControls {
  return rangeIntervals(controls.range).includes(controls.interval) ? controls : { ...controls, interval: rangeInterval(controls.range) };
}

export function allChartInterval(launchAt: number | undefined, now: number, plotWidth = 360): ChartInterval {
  if (launchAt === undefined) return RANGE_INTERVALS.all;
  const slots = Math.max(20, Math.floor(plotWidth / 6));
  return CHART_INTERVALS.find((interval) => (now - launchAt) / candleIntervalMs(interval) <= slots) ?? "1w";
}

/** A chart this sparse reads better one interval coarser: under a quarter of its buckets traded. */
const DENSE_SHARE = 0.25;

/**
 * The finest interval, from `interval` up, where at least a quarter of the buckets from the
 * first trade to `nowMs` traded, so a quiet coin opens on bars rather than a flat line.
 * `tradeTimes` are the starts of the traded candles read at `interval`.
 */
/** The bucket starts of candles that traded. */
export function tradedBuckets(candles: ChartCandlePage["candles"]): number[] {
  return candles.filter((candle) => candle.volumeQuote > 0n).map((candle) => candle.bucketStart);
}

export function denseInterval(tradeTimes: readonly number[], controls: ChartControls, nowMs: number): ChartInterval {
  if (controls.range === "live" || !tradeTimes.length) return controls.interval;
  const first = Math.min(...tradeTimes);
  const span = RANGE_MS[controls.range];
  const candidates = CHART_INTERVALS.filter((item) => candleIntervalMs(item) >= candleIntervalMs(controls.interval)
    && (span === null || span / candleIntervalMs(item) >= MIN_RANGE_BUCKETS));
  for (const item of candidates) {
    const step = candleIntervalMs(item);
    const traded = new Set(tradeTimes.map((at) => candleBucketStart(item, at))).size;
    const buckets = (candleBucketStart(item, nowMs) - candleBucketStart(item, first)) / step + 1;
    if (traded / buckets >= DENSE_SHARE) return item;
  }
  return candidates.at(-1) ?? controls.interval;
}

export const LIVE_CHART_CONTROLS = { interval: "1s", range: "live" } as const satisfies ChartControls;

export const CHART_CONTROLS_COOKIE = "blast-chart-controls";

type SearchValue = string | readonly string[] | undefined;

/** The controls a coin page URL names (`?interval=…&range=…`); a missing or unknown one is the default. */
export function parseChartControls(
  search: Readonly<Record<string, SearchValue>>,
  fallback: ChartControls = DEFAULT_CHART_CONTROLS,
): ChartControls {
  const pick = <T extends string>(value: SearchValue, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
  return fitControls({
    interval: pick(search.interval, CHART_INTERVALS, fallback.interval),
    range: pick(search.range, CHART_RANGES, fallback.range === "live" ? DEFAULT_CHART_CONTROLS.range : fallback.range),
  });
}

/** Streaming charts build active 1s candles from trades and recover them over HTTP. */
export function parseLiveChartControls(
  search: Readonly<Record<string, SearchValue>>,
  fallback: ChartControls = DEFAULT_CHART_CONTROLS,
): ChartControls {
  if (search.range === "live" || (search.range === undefined && fallback.range === "live")) return LIVE_CHART_CONTROLS;
  const controls = parseChartControls(search, fallback);
  const interval = LIVE_CHART_INTERVALS.find(interval => interval === search.interval);
  return fitControls({ ...controls, interval: interval ?? (controls.range === fallback.range ? fallback.interval : rangeInterval(controls.range)) });
}

export function preferredChartControls(saved: string, search: string, initial: ChartControls, live = true, livePreset = live): ChartControls {
  const fields = (value: string) => {
    const query = new URLSearchParams(value);
    return (key: string) => query.getAll(key).length === 1 ? query.get(key) ?? undefined : undefined;
  };
  const url = fields(search);
  const stored = fields(saved);
  const parse = live ? parseLiveChartControls : parseChartControls;
  if (!live) return parse({ interval: url("interval"), range: url("range") }, parse({ interval: stored("interval"), range: stored("range") }, initial));
  if (!livePreset && url("range") === "live") return initial;
  const savedRange = parse({ range: stored("range") }, initial).range;
  const range = parse({ range: url("range") }, { ...initial, range: savedRange }).range;
  const options = [url("interval"), stored(`interval.${range}`), range === stored("range") ? stored("interval") : undefined];
  const chosen = options.find(value => LIVE_CHART_INTERVALS.some(interval => interval === value));
  return parse({ interval: chosen, range }, { range, interval: range === initial.range ? initial.interval : rangeInterval(range) });
}

/** The query string of a direct link to these controls. */
export function chartSearch(controls: ChartControls): string {
  return `?${new URLSearchParams({ interval: controls.interval, range: controls.range }).toString()}`;
}

/**
 * One source's bounded read for a set of controls. `capped` when the range
 * holds more candles than one page (or is all history), so a full page may
 * leave older candles of it unread.
 */
export type ChartRequest = CandleRequest & Readonly<{ capped: boolean }>;

/**
 * The one bounded page each source is read with: the range's whole candles,
 * from the bucket that holds its start, at most a page (the newest when the
 * range holds more).
 */
export function chartRequest(controls: ChartControls, now: number): ChartRequest {
  if (controls.range === "live") {
    // Live reads a bounded tape. Its time window advances locally.
    return { interval: "1s", limit: LIVE_CHART_SPAN_MS / 1_000 + 1, capped: false };
  }
  const span = RANGE_MS[controls.range];
  if (span === null) return { interval: controls.interval, limit: CANDLE_PAGE.max, capped: true };
  const ms = candleIntervalMs(controls.interval);
  const from = candleBucketStart(controls.interval, now - span);
  const buckets = Math.floor((now - from) / ms) + 1;
  return { interval: controls.interval, from, limit: Math.min(CANDLE_PAGE.max, buckets), capped: buckets > CANDLE_PAGE.max };
}

/** Whether a page may leave older candles of its range unread: its read was capped at one page, and the page is full. */
export function pageTruncated(page: ChartCandlePage, request: ChartRequest): boolean {
  return page.truncated ?? (request.capped && request.limit !== undefined && page.candles.length >= request.limit);
}

/** The opening belongs to the first curve candle only when the query covers the launch. */
export function chartOpening(
  page: ChartCandlePage,
  request: ChartRequest,
  opening: Readonly<{ timestampMs: number; price: string }> | undefined,
) {
  const first = page.candles[0];
  if (!opening || !first || page.source !== "curve" || pageTruncated(page, request)) return undefined;
  const launchBucket = candleBucketStart(page.interval, opening.timestampMs);
  return (request.from === undefined || launchBucket >= request.from) && first.bucketStart >= launchBucket
    ? opening
    : undefined;
}

/** Intervals without trades between two candles of one source: `[from, to)`, `intervals` buckets long. */
export type CandleGap = Readonly<{ from: number; to: number; intervals: number }>;

/** A page's missing intervals between its candles. They are absent data, never a candle or a price. */
export function candleGaps(page: ChartCandlePage): CandleGap[] {
  const ms = candleIntervalMs(page.interval);
  return page.candles.slice(1).flatMap((candle, index) => {
    const from = page.candles[index].bucketStart + ms;
    return candle.bucketStart > from ? [{ from, to: candle.bucketStart, intervals: (candle.bucketStart - from) / ms }] : [];
  });
}

/** The chart can render venue candles whose read only supplies total trade counts. */
export type ChartCandle = Pick<Candle, "bucketStart" | "open" | "high" | "low" | "close" | "volumeQuote" | "trades"> &
  Partial<Pick<Candle, "buys" | "sells">>;
export type ChartCandlePage = Omit<PoolCandlePage, "candles" | "venue"> & Readonly<{ venue: string; candles: readonly ChartCandle[]; truncated?: boolean; liveTrades?: readonly PoolTrade[] }>;

/** One source's chart: blast-infra's section, or loading before its first answer. */
export type SourceState = Section<ChartCandlePage> | Readonly<{ state: "loading" }>;

export type ChartState = Readonly<{
  /** The controls these candles were read for (`chartKey`). */
  key: string;
  curve: SourceState;
  /** Null while the launch has no venue source. */
  venue: SourceState | null;
  /** The committed migration the chart is drawn around; null before one. */
  migration: MigrationMarker | null;
}>;

/** The curve and, after migration, the venue section even when its pool cannot be read. */
export function chartSources(state: ChartState): Readonly<{ name: "curve" | "venue"; section: SourceState | null }>[] {
  return [
    { name: "curve", section: state.curve },
    ...(state.migration !== null || state.venue !== null ? [{ name: "venue" as const, section: state.venue }] : []),
  ];
}

/** The latest committed checkpoint of either answered source, including one the viewer hid. */
export function chartLatestTimestamp(state: ChartState): number {
  return Math.max(0, ...[state.curve, state.venue].flatMap((section) =>
    section && (section.state === "available" || section.state === "stale" || section.state === "empty") ? [section.provenance.timestampMs ?? 0] : [],
  ));
}

/** The key of the candles a set of controls reads. */
export function chartKey(controls: ChartControls): string {
  return `${controls.interval}|${controls.range}`;
}

export function initialChart(key: string, venue = false, migration: MigrationMarker | null = null): ChartState {
  return { key, curve: { state: "loading" }, venue: venue ? { state: "loading" } : null, migration };
}

/** The last answer kept through an outage: Stale with its own provenance and the current failure. */
function settle(previous: SourceState | null, next: Section<ChartCandlePage>): Section<ChartCandlePage> {
  if (next.state !== "unavailable" || !previous || (previous.state !== "available" && previous.state !== "stale")) return next;
  return { state: "stale", data: previous.data, provenance: previous.provenance, reason: next.reason };
}

/** A page bounded by another migration than the committed one is no chart of this launch. */
function onRoute(section: Section<ChartCandlePage>, committed: MigrationMarker | null): Section<ChartCandlePage> {
  if (section.state !== "available" && section.state !== "stale") return section;
  const named = section.data.migration;
  if (!committed || !named || (named.cursor === committed.cursor && named.timestampMs === committed.timestampMs)) return section;
  return { state: "unavailable", reason: "route-mismatch", provenance: section.provenance };
}

/**
 * The chart after one read of its sources for `key`. Each source settles on
 * its own. A read for other controls than the chart's (`state.key`, which a
 * controls change resets) is dropped, so candles are never shown under
 * controls they were not read for. The marker is the committed migration from
 * the coin summary, else the one the pages name.
 */
export function afterChartRead(
  state: ChartState,
  key: string,
  chart: MigratedChart,
  committed: MigrationMarker | null,
): ChartState {
  if (state.key !== key) return state;
  const migration = committed ?? chart.migration ?? state.migration;
  return {
    key,
    curve: settle(state.curve, onRoute(chart.curve, migration)),
    venue: chart.venue === null ? null : settle(state.venue, onRoute(chart.venue, migration)),
    migration,
  };
}

/** A streaming recovery settles only its own source and keeps the committed route. */
export function afterChartSourceRead(state: ChartState, key: string, name: "curve" | "venue", next: Section<ChartCandlePage>, committed: MigrationMarker | null): ChartState {
  if (state.key !== key) return state;
  const migration = committed ?? ((next.state === "available" || next.state === "stale") ? next.data.migration : null) ?? state.migration;
  return { ...state, migration, [name]: settle(state[name], onRoute(next, migration)) };
}
