import { candleBucketStart, candleIntervalMs, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { poolPrices } from "../candle-data.ts";
import { chartNumber } from "../chart-price.ts";

/** One KLineCharts bar: a bucket's start (ms), its prices in the shown unit and its quote volume. */
export type Bar = Readonly<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;

/**
 * Every source's candles as one series, oldest first, priced per whole token in the shown
 * unit (USD when `quoteUsd` is known). A bucket both sources hold (the migration bucket)
 * becomes one bar: the curve's open, the venue's close, the wider range, both volumes.
 * Live carries the last close from before its window as a flat bar at the window start,
 * so a quiet coin still shows its price.
 */
export function klineBars(sources: readonly DrawnSeries[], memeDecimals: number | null, quoteDecimals: number | null, quoteUsd: string | null): Bar[] {
  const { price } = poolPrices(memeDecimals, quoteDecimals, quoteUsd);
  const volume = (atoms: bigint) => Number(shiftDecimal(atoms.toString(), -(quoteDecimals ?? 0)));
  const byStart = new Map<number, Bar>();
  for (const { page, carriedClose } of sources) {
    const first = page.candles[0]?.bucketStart ?? Infinity;
    if (carriedClose && carriedClose.timestampMs < first) {
      const close = Number(price(carriedClose.price));
      const bar = { timestamp: carriedClose.timestampMs, open: close, high: close, low: close, close, volume: 0 };
      const held = byStart.get(bar.timestamp);
      byStart.set(bar.timestamp, held ? joinBars(held, bar) : bar);
    }
  }
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

/** The chart fills at most this many of the newest buckets; older quiet buckets stay out. */
export const MAX_FILLED_BARS = 2_000;

function flatBar(timestamp: number, close: number): Bar {
  return { timestamp, open: close, high: close, low: close, close, volume: 0 };
}

/**
 * KLineCharts spaces bars by index, so the chart's series is made continuous: each bar
 * snaps to its bucket and opens at the previous close (its range widened to match), and
 * a bucket without trades becomes a flat bar at the previous close with no volume, up to
 * the bucket holding `nowMs`. Only the newest `cap` buckets are filled, so a long quiet
 * history stays light; the time axis then keeps its pace on a quiet coin.
 */
export function fillGaps(bars: readonly Bar[], interval: CandleInterval, nowMs: number, cap = MAX_FILLED_BARS): readonly Bar[] {
  if (!bars.length) return bars;
  const step = candleIntervalMs(interval);
  const end = Math.max(candleBucketStart(interval, nowMs), candleBucketStart(interval, bars.at(-1)!.timestamp));
  const from = end - (cap - 1) * step;
  const filled: Bar[] = [];
  for (const bar of bars) {
    const at = candleBucketStart(interval, bar.timestamp);
    const previous = filled.at(-1);
    if (previous && at <= previous.timestamp) {
      filled[filled.length - 1] = joinBars(previous, bar);
      continue;
    }
    if (previous) for (let next = Math.max(previous.timestamp + step, from); next < at; next += step) filled.push(flatBar(next, previous.close));
    const open = previous ? previous.close : bar.open;
    filled.push({ ...bar, timestamp: at, open, high: Math.max(bar.high, open), low: Math.min(bar.low, open) });
  }
  const last = filled.at(-1)!;
  for (let next = Math.max(last.timestamp + step, from); next <= end; next += step) filled.push(flatBar(next, last.close));
  return filled;
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
 * itself changed (another interval, another unit, or an older bar the server filled in).
 */
export function barChanges(shown: readonly Bar[], next: readonly Bar[]): Readonly<{ kind: "reset" }> | Readonly<{ kind: "update"; bars: readonly Bar[]; kept: readonly Bar[] }> {
  const offset = next.length ? shown.findIndex((bar) => bar.timestamp === next[0]!.timestamp) : -1;
  if (offset < 0) return { kind: "reset" };
  const overlap = shown.length - offset;
  if (next.length < overlap) return { kind: "reset" };
  for (let index = 0; index < overlap - 1; index++) {
    const before = shown[offset + index]!;
    // An older bar can't be redrawn in place, so any change to it reloads the plot.
    if (!sameBar(before, next[index]!)) return { kind: "reset" };
  }
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

/** History with every live trade it has not seen yet folded in, oldest trade first. */
export function foldTrades(history: readonly Bar[], interval: CandleInterval, trades: ReadonlyArray<Readonly<{ timestampMs: number; price: number; volume: number }>>): readonly Bar[] {
  if (!trades.length) return history;
  const bars = [...history];
  for (const trade of [...trades].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const open = foldTrade(bars, interval, trade.timestampMs, trade.price, trade.volume);
    if (!open) continue;
    if (bars.at(-1)?.timestamp === open.timestamp) bars[bars.length - 1] = open;
    else bars.push(open);
  }
  return bars;
}

/**
 * Pane heights in px: the price pane, and under it the volume pane with its 1 px separator.
 */
export const PANE_LAYOUT = { phone: { price: 200, pane: 64 }, desktop: { price: 290, pane: 100 } } as const;
const TIME_AXIS = 25;

/** The plot's height in px: price pane, volume pane with its separator, time axis. */
export function plotHeightFor(phone: boolean): number {
  const layout = phone ? PANE_LAYOUT.phone : PANE_LAYOUT.desktop;
  return layout.price + layout.pane + 1 + TIME_AXIS;
}

/**
 * A price as the readout writes it. Four or more zeros after the point are counted, not
 * written: 0.0000812 is `{ zeros: 4, rest: "812" }`, shown as 0.0₄812.
 */
export function priceParts(value: number, precision: number): Readonly<{ text: string; zeros?: number; rest?: string }> {
  const text = value.toFixed(precision);
  const folded = /^0\.(0{4,})(\d+)$/.exec(text);
  return folded ? { text, zeros: folded[1]!.length, rest: folded[2]! } : { text };
}

/** Volume in the quote coin: 0 when quiet, three significant digits under one (zeros folded), compact above. */
export function volumeText(volume: number): string {
  if (!(volume > 0)) return "0";
  if (volume < 1) return chartNumber(volume, 3);
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: volume < 1_000 ? 2 : 1 }).format(volume);
}

/** The library's date templates, read as the viewer's own short dates: "Nov 26" on the axis, "Wed, Nov 26, 14:30" under the crosshair. */
const CHART_DATE_OPTIONS: Readonly<Record<string, Intl.DateTimeFormatOptions>> = {
  YYYY: { year: "numeric" },
  "YYYY-MM": { month: "short", year: "numeric" },
  "MM-DD": { month: "short", day: "numeric" },
  "YYYY-MM-DD": { month: "short", day: "numeric", year: "numeric" },
  "HH:mm": { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  "HH:mm:ss": { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  "MM-DD HH:mm": { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  "YYYY-MM-DD HH:mm": { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};
const chartDateFormats = new Map<string, Intl.DateTimeFormat>();

export function chartDate(timestamp: number, template: string, timeZone?: string): string {
  const key = `${template}|${timeZone ?? ""}`;
  let format = chartDateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, { ...(CHART_DATE_OPTIONS[template] ?? CHART_DATE_OPTIONS["YYYY-MM-DD HH:mm"]), timeZone });
    chartDateFormats.set(key, format);
  }
  return format.format(timestamp);
}

/** Axis labels whose text would run past either edge of the plot; the library centres each on its bar and lets the edge cut it. */
export function ticksInside<T extends { coord: number; text: string | number }>(ticks: readonly T[], width: number, charWidth = 6.5): T[] {
  return ticks.filter(({ coord, text }) => {
    const half = (String(text).length * charWidth) / 2;
    return coord - half >= 0 && coord + half <= width;
  });
}

/**
 * The y-axis `gap.top` that keeps `px` free above the highest value in a `height` px pane.
 * KLineCharts adds the gap as a share of the value range, not of the pane, and `bottom`
 * (a share too) widens the range as well, so `px / height` alone leaves less room.
 * Capped under 1, since KLineCharts reads a gap of 1 or more as pixels.
 */
export function topGap(px: number, height: number, bottom: number): number {
  return px < height ? Math.min(.99, px * (1 + bottom) / (height - px)) : .99;
}
