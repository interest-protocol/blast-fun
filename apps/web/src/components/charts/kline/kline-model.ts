import { candleBucketStart, candleIntervalMs, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { poolPrices } from "../candle-data.ts";

/** One KLineCharts bar: a bucket's start (ms), its prices in the shown unit and its quote volume. */
export type Bar = Readonly<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;

/**
 * Every source's candles as one series, oldest first, priced per whole token in the shown
 * unit (USD when `quoteUsd` is known). A bucket both sources hold (the migration bucket)
 * becomes one bar: the curve's open, the venue's close, the wider range, both volumes.
 */
export function klineBars(sources: readonly DrawnSeries[], memeDecimals: number | null, quoteDecimals: number | null, quoteUsd: string | null): Bar[] {
  const { price } = poolPrices(memeDecimals, quoteDecimals, quoteUsd);
  const volume = (atoms: bigint) => Number(shiftDecimal(atoms.toString(), -(quoteDecimals ?? 0)));
  const byStart = new Map<number, Bar>();
  for (const { page } of sources) for (const candle of page.candles) {
    const bar = {
      timestamp: candle.bucketStart,
      open: Number(price(candle.open)),
      high: Number(price(candle.high)),
      low: Number(price(candle.low)),
      close: Number(price(candle.close)),
      volume: volume(candle.volumeQuote),
    };
    const held = byStart.get(bar.timestamp);
    byStart.set(bar.timestamp, held ? joinBars(held, bar) : bar);
  }
  return [...byStart.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function joinBars(earlier: Bar, later: Bar): Bar {
  return {
    timestamp: earlier.timestamp,
    open: earlier.open,
    high: Math.max(earlier.high, later.high),
    low: Math.min(earlier.low, later.low),
    close: later.close,
    volume: earlier.volume + later.volume,
  };
}

/**
 * Decimals that keep four significant digits of the smallest price shown, from 2 (a
 * dollar coin) to 16 (a coin at 1e-12). The axis folds the leading zeros (0.0₉1234).
 */
export function pricePrecision(bars: readonly Bar[]): number {
  let smallest = Infinity;
  for (const bar of bars) if (bar.low > 0 && bar.low < smallest) smallest = bar.low;
  if (!Number.isFinite(smallest)) return 2;
  return Math.min(16, Math.max(2, 3 - Math.floor(Math.log10(smallest))));
}

/**
 * How the chart moves from `shown` to `next` without losing the viewer's zoom and scroll:
 * `update` when only the newest bars changed or were added (each is pushed in order; a
 * rolling window that dropped its oldest bars keeps them on screen), `reset` when history
 * itself changed (another interval, another unit, a gap filled).
 */
export function barChanges(shown: readonly Bar[], next: readonly Bar[]): Readonly<{ kind: "reset" }> | Readonly<{ kind: "update"; bars: readonly Bar[]; kept: readonly Bar[] }> {
  const offset = next.length ? shown.findIndex((bar) => bar.timestamp === next[0]!.timestamp) : -1;
  if (offset < 0) return { kind: "reset" };
  const overlap = shown.length - offset;
  if (next.length < overlap) return { kind: "reset" };
  for (let index = 0; index < overlap - 1; index++) if (!sameBar(shown[offset + index]!, next[index]!)) return { kind: "reset" };
  if (next[overlap - 1]!.timestamp !== shown.at(-1)!.timestamp) return { kind: "reset" };
  const bars = sameBar(shown.at(-1)!, next[overlap - 1]!) ? next.slice(overlap) : next.slice(overlap - 1);
  return { kind: "update", bars, kept: [...shown.slice(0, offset), ...next] };
}

function sameBar(a: Bar, b: Bar): boolean {
  return a.timestamp === b.timestamp && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}

/**
 * The open bar after one trade at `price` (shown unit) and `volume` (quote), built in the
 * browser: the trade's bucket extends the newest bar, or opens a new one at the previous
 * close. A trade older than the newest bar is already in history and changes nothing.
 */
export function foldTrade(bars: readonly Bar[], interval: CandleInterval, timestampMs: number, price: number, volume: number): Bar | null {
  if (!(price > 0)) return null;
  const start = candleBucketStart(interval, timestampMs);
  const last = bars.at(-1);
  if (last && start < last.timestamp) return null;
  if (last && start === last.timestamp)
    return { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, volume: last.volume + volume };
  const open = last?.close ?? price;
  return { timestamp: start, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume };
}

/**
 * Finer bars rolled up into `interval` (5m–4h from 1m, 1w from 1d), oldest first. The
 * stream sends 1m and 1d frames; the browser builds every other open bar from them.
 */
export function rollUp(bars: readonly Bar[], interval: CandleInterval): Bar[] {
  const rolled: Bar[] = [];
  for (const bar of bars) {
    const start = candleBucketStart(interval, bar.timestamp);
    const last = rolled.at(-1);
    if (last && last.timestamp === start) rolled[rolled.length - 1] = joinBars(last, { ...bar, timestamp: start });
    else rolled.push({ ...bar, timestamp: start });
  }
  return rolled;
}

/** The finer interval a coarser one is rolled up from, if any. */
export function rollUpSource(interval: CandleInterval): CandleInterval | null {
  if (interval === "1w") return "1d";
  if (interval === "1s" || interval === "1m" || interval === "1d") return null;
  return candleIntervalMs(interval) < candleIntervalMs("1d") ? "1m" : null;
}

export const MAIN_INDICATORS = ["MA", "EMA", "BOLL"] as const;
export const PANE_INDICATORS = ["VOL", "MACD", "RSI"] as const;
export type IndicatorName = (typeof MAIN_INDICATORS)[number] | (typeof PANE_INDICATORS)[number];
const INDICATORS: readonly IndicatorName[] = [...MAIN_INDICATORS, ...PANE_INDICATORS];

export type ChartSettings = Readonly<{ indicators: readonly IndicatorName[] }>;
export const DEFAULT_CHART_SETTINGS: ChartSettings = { indicators: ["MA", "VOL"] };
export const CHART_SETTINGS_KEY = "blast:coin-chart:v1";

/** Saved settings, keeping only known indicators; anything unreadable is the default. */
export function readChartSettings(text: string | null): ChartSettings {
  if (!text) return DEFAULT_CHART_SETTINGS;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return DEFAULT_CHART_SETTINGS;
    const { indicators } = value as { indicators?: unknown };
    return {
      indicators: Array.isArray(indicators) ? INDICATORS.filter((name) => indicators.includes(name)) : DEFAULT_CHART_SETTINGS.indicators,
    };
  } catch {
    return DEFAULT_CHART_SETTINGS;
  }
}

export function toggleIndicator(settings: ChartSettings, name: IndicatorName): ChartSettings {
  const on = settings.indicators.includes(name);
  return { ...settings, indicators: on ? settings.indicators.filter((item) => item !== name) : INDICATORS.filter((item) => item === name || settings.indicators.includes(item)) };
}
