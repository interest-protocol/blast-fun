export type ExactCandle = Readonly<{
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}>;

export type ExactSeries = Readonly<{
  values: ReadonlyMap<number, string>;
  times: readonly number[];
  candles?: ReadonlyMap<number, ExactCandle>;
}>;

/** How a price between points reads: only at points, a flat hold, or a step that holds until the next point. */
export type PriceHold = boolean | "step";

function seriesPrice(series: ExactSeries | undefined, at: number, held: PriceHold) {
  if (!series) return undefined;
  const exact = series.values.get(at);
  if (exact !== undefined || !held) return exact;

  // A flat line between two prices represents a held close. Its price is exact
  // at an empty timeline slot only if both surrounding points hold that value.
  let low = 0;
  let high = series.times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (series.times[middle]! < at) low = middle + 1;
    else high = middle;
  }
  const before = series.values.get(series.times[low - 1]!);
  // A step holds the previous point's price inside the trace; a whitespace point ends it.
  if (held === "step") return low < series.times.length && series.times[low] !== at ? before : undefined;
  const after = series.values.get(series.times[low]!);
  return before === after ? before : undefined;
}

export function exactChartPrice(series: readonly ExactSeries[], at: number, picked: number, held: PriceHold) {
  const selected = seriesPrice(series[picked], at, held);
  if (selected !== undefined) return selected;

  let price: string | undefined;
  for (const source of series) {
    const value = seriesPrice(source, at, held);
    if (value === undefined) continue;
    if (price !== undefined && price !== value) return undefined;
    price = value;
  }
  return price;
}

/** A tied close alone cannot identify which pool supplied a candle or its volume. */
export function exactChartCandle(series: readonly ExactSeries[], at: number, picked: number) {
  const selected = series[picked]?.candles?.get(at);
  if (selected) return selected;

  let candle: ExactCandle | undefined;
  for (const source of series) {
    const candidate = source.candles?.get(at);
    if (!candidate) continue;
    if (candle) return undefined;
    candle = candidate;
  }
  return candle;
}

type PriceBand = Readonly<{ close: number; top: number; bottom: number }>;

export function nearestPriceSeries(bands: readonly (PriceBand | null)[], y: number) {
  let selected = -1;
  let bandDistance = Infinity;
  let closeDistance = Infinity;
  for (const [index, band] of bands.entries()) {
    if (!band) continue;
    const gap = Math.max(band.top - y, y - band.bottom, 0);
    const close = Math.abs(band.close - y);
    if (gap > bandDistance || (gap === bandDistance && close > closeDistance)) continue;
    selected = gap === bandDistance && close === closeDistance ? -1 : index;
    bandDistance = gap;
    closeDistance = close;
  }
  return selected;
}

export function migrationCaptionOffset(x: number, plotWidth: number, captionWidth: number) {
  const inset = 4;
  const rightmost = Math.max(inset, plotWidth - inset - captionWidth);
  const preferred = x + inset <= rightmost ? x + inset : x - inset - captionWidth;
  return Math.max(inset, Math.min(preferred, rightmost)) - x;
}
