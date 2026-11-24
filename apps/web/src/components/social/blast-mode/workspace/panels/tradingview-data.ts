import { chartTimestamp } from "#web/components/charts/tradingview-model.ts";
import { exactDecimal, unitsAt } from "@blast/core/web/exact-amount.ts";
import { axisPrice, type chartVisual } from "./chart-visual";

export type ChartGeometry = NonNullable<ReturnType<typeof chartVisual>>;
export { chartTimestamp, restoredChartRange, type SavedChartView } from "#web/components/charts/tradingview-model.ts";

/** Only normalized coordinates enter the canvas library; original prices stay exact. */
export function tradingViewPriceLabel(
  visual: ChartGeometry,
  coordinate: number,
  significant?: number,
): string {
  const high = exactDecimal(visual.ticks[0]!.value)!;
  const low = exactDecimal(visual.ticks.at(-1)!.value)!;
  const scale = Math.max(high.scale, low.scale) + 3;
  const hi = unitsAt(high, scale, "floor");
  const lo = unitsAt(low, scale, "floor");
  const value =
    lo + ((hi - lo) * BigInt(Math.round((coordinate - 18) * 1000))) / 264_000n;
  const digits = (value > 0n ? value : 0n).toString().padStart(scale + 1, "0");
  const exact = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    : digits;
  const precision =
    significant ??
    Math.max(5, hi.toString().length - (hi - lo).toString().length + 3);
  return axisPrice(exact, precision);
}

/** Bounded whitespace gives missing buckets space without inventing a price. */
export function tradingViewTimeline(visual: ChartGeometry, intervalMs: number) {
  const step =
    intervalMs *
    Math.max(1, Math.ceil((visual.end - visual.start) / intervalMs / 4000));
  const times = new Set(visual.points.map((point) => point.at));
  for (let at = visual.start; at <= visual.end; at += step) times.add(at);
  return [...times]
    .sort((a, b) => a - b)
    .map((at) => ({ time: chartTimestamp(at) }));
}

/** Interpolate time between real scale slots, including events between candle buckets. */
export function projectChartTime(
  times: readonly number[],
  at: number,
  coordinate: (at: number) => number | null,
): number | null {
  if (!times.length || at < times[0]! || at > times.at(-1)!) return null;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (times[mid]! < at) low = mid + 1;
    else high = mid;
  }
  if (times[low] === at) return coordinate(at);
  const before = times[low - 1]!;
  const after = times[low]!;
  const left = coordinate(before);
  const right = coordinate(after);
  return left === null || right === null
    ? null
    : left + ((right - left) * (at - before)) / (after - before);
}
