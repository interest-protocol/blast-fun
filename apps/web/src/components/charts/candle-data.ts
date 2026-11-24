import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { ChartCandle } from "#web/components/launchpad/chart/chart-model.ts";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
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

export function sourceLineBounds({ page, source, observedAt, holdAfterMigration }: DrawnSeries, migrationAt?: number, rolling = false) {
  const curveEnd = source === "curve" && !holdAfterMigration ? migrationAt ?? Infinity : Infinity;
  const priceThrough = Math.min(rolling ? Infinity : observedAt ?? Infinity, curveEnd);
  // A venue's first bucket may span the migration, but its line starts only at the migration.
  const priceFrom = source === "venue" ? migrationAt ?? page.migration?.timestampMs ?? -Infinity : -Infinity;
  return { priceFrom, priceThrough };
}

type PricePoint = Readonly<{ timestampMs: number; price: string }>;

/** Anchor both sources at the previous close when the chart reaches the migration. */
export function poolLinePoints(sources: readonly DrawnSeries[], migrationAt?: number, end = Infinity, rolling = false) {
  let curveClose: PricePoint | undefined;
  return sources.map((history) => {
    const { page, opening, carriedClose, source } = history;
    const { priceFrom, priceThrough } = sourceLineBounds(history, migrationAt, rolling);
    const through = Math.min(end, priceThrough);
    const points = linePoints(page.candles, opening, candleIntervalMs(page.interval), priceFrom, through);
    const carried = carriedClose && carriedClose.timestampMs <= through ? holdPreviousClose(points, carriedClose, through, false) : points;
    const bridge = source === "venue" && migrationAt !== undefined && carried.length ? curveClose : undefined;
    const line = bridge ? holdPreviousClose(carried, bridge, through, true) : carried;
    if (source === "curve") curveClose = line.at(-1);
    return line;
  });
}

function holdPreviousClose(points: readonly PricePoint[], anchor: PricePoint, through: number, bridge: boolean): readonly PricePoint[] {
  const first = points[0];
  if (!first) return anchor.timestampMs < through && Number.isFinite(through)
    ? [anchor, { ...anchor, timestampMs: through }]
    : [anchor];
  if (anchor.timestampMs > first.timestampMs) return points;
  if (anchor.timestampMs === first.timestampMs) {
    if (!bridge) return points;
    const shift = Math.min(0.5, ((points[1]?.timestampMs ?? Infinity) - first.timestampMs) / 2);
    return [anchor, { ...first, timestampMs: first.timestampMs + shift }, ...points.slice(1)];
  }
  const holdUntil = first.timestampMs - 0.5;
  return holdUntil > anchor.timestampMs ? [anchor, { ...anchor, timestampMs: holdUntil }, ...points] : [anchor, ...points];
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
