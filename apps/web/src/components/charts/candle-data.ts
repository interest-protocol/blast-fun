import type { ChartCandle } from "#web/components/launchpad/chart/chart-model.ts";
import {
  exactDecimal,
  exactText,
  fixedExact,
  multiplyExact,
  type Exact,
} from "@blast/core/lib/exact-amount.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";

/** Convert the indexer's price to quote units per whole token, or USD when the rate is known. */
export function poolPrices(memeDecimals: number | null, quoteDecimals: number | null, quoteUsd: string | null = null) {
  const hasUnits = memeDecimals !== null && quoteDecimals !== null;
  const rate = hasUnits ? exactDecimal(quoteUsd) : null;
  function price(value: string) {
    if (!hasUnits) return value;
    const whole = shiftDecimal(value, memeDecimals - quoteDecimals);
    const exact = rate && exactDecimal(whole);
    return rate && exact ? exactText(multiplyExact(exact, rate)) : whole;
  }
  return { usd: rate !== null, price };
}

/** A close in a partial launch or migration bucket stays on its own side of the boundary. */
export function lineCloseTime(bucket: number, openingAt: number | undefined, interval: number, priceFrom: number, priceThrough: number) {
  return openingAt !== undefined && openingAt >= bucket
    ? Math.max(openingAt + 0.5, Math.min(bucket + interval - 1, priceThrough))
    : Math.max(bucket, priceFrom);
}

/**
 * The line's points: each close at its bucket start, never before `priceFrom`
 * (a venue starts at the migration, inside its first bucket), so a venue line
 * cannot start left of where the curve line ends and cross it.
 *
 * The line is continuous. A bucket without trades has no candle, but the price
 * did not vanish: it stayed at the last close. So each stretch of empty buckets
 * holds that close flat up to the bucket before the next candle, instead of
 * breaking the line or slanting across the stretch.
 */
export function linePoints(
  candles: readonly Pick<ChartCandle, "bucketStart" | "close">[],
  opening: Readonly<{ timestampMs: number; price: string }> | undefined,
  interval: number,
  priceFrom: number,
  priceThrough: number,
) {
  const closes = candles.flatMap((candle, index) => {
    const point = {
      timestampMs: lineCloseTime(candle.bucketStart, index === 0 ? opening?.timestampMs : undefined, interval, priceFrom, priceThrough),
      price: candle.close,
    };
    // The last price before this candle: the previous close, or the opening price before the first trade.
    const held = index > 0
      ? candles[index - 1]!.bucketStart + interval < candle.bucketStart ? candles[index - 1]!.close : null
      : opening && opening.timestampMs + interval < candle.bucketStart ? opening.price : null;
    return held === null
      ? [point]
      : [{ timestampMs: Math.max(candle.bucketStart - interval, priceFrom), price: held }, point];
  });
  const points = opening ? [opening, ...closes] : closes;
  // A line that ends before `priceThrough` (the migration, or the moment the page was read) holds its last price up to it.
  const last = points.at(-1);
  return last && Number.isFinite(priceThrough) && last.timestampMs < priceThrough
    ? [...points, { timestampMs: priceThrough, price: last.price }]
    : points;
}

/** Sources share quote units; sum their real volume once per bucket, without floats. */
export function combinedVolumes(
  points: readonly { at: number; volume: string; down: boolean }[],
) {
  const buckets = new Map<
    number,
    { exact: Exact; count: number; down: boolean | null }
  >();
  for (const point of points) {
    const exact = exactDecimal(point.volume)!;
    const previous = buckets.get(point.at);
    const scale = Math.max(previous?.exact.scale ?? 0, exact.scale);
    const n =
      exact.n * 10n ** BigInt(scale - exact.scale) +
      (previous
        ? previous.exact.n * 10n ** BigInt(scale - previous.exact.scale)
        : 0n);
    buckets.set(point.at, {
      exact: { n, scale },
      count: (previous?.count ?? 0) + 1,
      down: previous && previous.down !== point.down ? null : point.down,
    });
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([at, bucket]) => ({
      at,
      volume: fixedExact(bucket.exact, bucket.exact.scale),
      combined: bucket.count > 1,
      color:
        bucket.down === null
          ? "var(--muted)"
          : bucket.down
            ? "var(--down)"
            : "var(--up)",
    }));
}
