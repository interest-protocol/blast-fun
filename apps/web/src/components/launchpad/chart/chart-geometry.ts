// Where the chart draws each candle, gap and the migration. Drawing only:
// numbers here place marks on the canvas and never reach a label or a table.
// A candle is drawn at its own bucket from its own raw high, low, open and
// close; nothing joins two candles, so a missing interval stays empty.

import { candleBucketStart, candleIntervalMs, comparePrices, type MigrationMarker } from "@blast/core/modules/launchpad-contract/venue-history.ts";

import { candleGaps, type CandleGap, type ChartCandle, type ChartCandlePage } from "./chart-model";

export const CHART_WIDTH = 1000;
export const CHART_HEIGHT = 300;
/** The strip above the price pane where the migration marker's label sits, so it never covers a candle. */
const LABEL_BAND = 30;
const PRICE_TOP = 34;
const PRICE_BOTTOM = 212;
const VOLUME_TOP = 228;
const VOLUME_BOTTOM = 292;

export type DrawnSeries = Readonly<{
  source: "curve" | "venue";
  page: ChartCandlePage;
  opening?: Readonly<{ timestampMs: number; price: string }>;
  carriedClose?: Readonly<{ timestampMs: number; price: string }>;
  observedAt?: number | null;
  holdAfterMigration?: boolean;
}>;

export type DrawnCandle = Readonly<{
  source: "curve" | "venue";
  candle: ChartCandle;
  /** The exact order of its close against its open (`comparePrices`), as the table names it. */
  direction: "up" | "down" | "flat";
  /** Body left edge and width; the wick runs at `wickX`. */
  x: number;
  width: number;
  wickX: number;
  highY: number;
  lowY: number;
  bodyTop: number;
  bodyHeight: number;
  /** The close: the body's top after a rise, its bottom after a fall. A tick runs from the body's right edge to `closeTickEnd`. */
  closeY: number;
  closeTickEnd: number;
  /** An unchanged candle's open tick, from `openTickStart` to the body's left edge at the close's level; null otherwise. */
  openTickStart: number | null;
  volumeTop: number;
}>;

export type DrawnGap = Readonly<{ source: "curve" | "venue"; gap: CandleGap; x: number; width: number }>;

export type ChartGeometry = Readonly<{
  candles: readonly DrawnCandle[];
  gaps: readonly DrawnGap[];
  /** The migration's x, when it falls inside the drawn time range. */
  migrationX: number | null;
  /** The drawn time range, in Unix ms. */
  start: number;
  end: number;
  /** The extreme raw prices drawn: the axis's top and bottom labels. */
  highest: string;
  lowest: string;
}>;

/** A canonical price string as a number, for placement only. */
const place = (price: string) => Number(price);

/**
 * Places the series' candles on one time axis from `from` (or the first
 * candle) to the later of the last candle's end and `chainTime` (the
 * committed checkpoint's time). In the bucket that holds the migration, the
 * curve's candle is drawn in the part before the marker and the venue's in
 * the part after it, so no candle crosses the committed boundary. Null when
 * there is nothing to draw.
 */
export function chartGeometry(
  series: readonly DrawnSeries[],
  migration: MigrationMarker | null,
  from: number | undefined,
  chainTime: number | null,
): ChartGeometry | null {
  const drawn = series.filter(({ page, carriedClose }) => page.candles.length > 0 || carriedClose);
  if (drawn.length === 0) return null;
  const interval = drawn[0].page.interval;
  const ms = candleIntervalMs(interval);
  const all = drawn.flatMap(({ page }) => page.candles);
  const carries = drawn.flatMap(({ carriedClose }) => carriedClose ? [carriedClose] : []);
  const start = Math.min(
    from ?? Infinity,
    ...all.map((candle) => candle.bucketStart),
    ...carries.map(({ timestampMs }) => timestampMs),
    ...drawn.flatMap(({ opening }) => opening ? [candleBucketStart(interval, opening.timestampMs)] : []),
  );
  const end = Math.max(chainTime ?? 0, ...all.map((candle) => candle.bucketStart + ms), start + 1);
  const x = (time: number) => ((time - start) / (end - start)) * CHART_WIDTH;

  const highPrices = [...all.map(({ high }) => high), ...carries.map(({ price }) => price)];
  const lowPrices = [...all.map(({ low }) => low), ...carries.map(({ price }) => price)];
  const highest = highPrices.reduce((top, price) => place(price) > place(top) ? price : top);
  const lowest = lowPrices.reduce((bottom, price) => place(price) < place(bottom) ? price : bottom);
  const [high, low] = [place(highest), place(lowest)];
  const pad = high === low ? Math.max(high * 0.05, Number.MIN_VALUE) : 0;
  const y = (price: string) => PRICE_TOP + ((high + pad - place(price)) / (high - low + 2 * pad)) * (PRICE_BOTTOM - PRICE_TOP);
  const volumes = all.map((candle) => Number(candle.volumeQuote));
  const maxVolume = Math.max(...volumes, 1);

  // The curve trades up to the migration and the venue after it, so they meet only in its bucket.
  const migrationBucket = migration ? candleBucketStart(interval, migration.timestampMs) : null;
  const slotOf = (source: DrawnSeries["source"], bucketStart: number): [number, number] => {
    const [left, right] = [x(bucketStart), x(bucketStart + ms)];
    if (bucketStart !== migrationBucket) return [left, right];
    const marker = x(migration!.timestampMs);
    return source === "curve" ? [left, marker] : [marker, right];
  };
  const candles = drawn.flatMap(({ source, page }) =>
    page.candles.map((candle): DrawnCandle => {
      const [left, right] = slotOf(source, candle.bucketStart);
      const slot = right - left;
      const width = Math.max(1, slot * 0.7);
      // Centred in its slot; a slot narrower than a body keeps the body on its side of the marker.
      const centred = left + (slot - width) / 2;
      const bodyX = source === "curve" ? Math.min(centred, right - width) : Math.max(centred, left);
      const [openY, closeY] = [y(candle.open), y(candle.close)];
      const order = comparePrices(candle.close, candle.open);
      const direction = order > 0 ? "up" : order < 0 ? "down" : "flat";
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(openY - closeY));
      return {
        source,
        candle,
        direction,
        x: bodyX,
        width,
        wickX: bodyX + width / 2,
        highY: y(candle.high),
        lowY: y(candle.low),
        bodyTop,
        bodyHeight,
        closeY: direction === "down" ? bodyTop + bodyHeight : bodyTop,
        // Into the slot's right margin, short of the next candle and of the marker.
        closeTickEnd: bodyX + width + Math.max(0, right - bodyX - width) * 0.75,
        // Unchanged: a matching tick into the left margin, so the candle reads as level without colour.
        openTickStart: direction === "flat" ? bodyX - Math.max(0, bodyX - left) * 0.75 : null,
        volumeTop: VOLUME_BOTTOM - (Number(candle.volumeQuote) / maxVolume) * (VOLUME_BOTTOM - VOLUME_TOP),
      };
    }),
  );
  const gaps = drawn.flatMap(({ source, page }) =>
    candleGaps(page).map((gap) => ({ source, gap, x: x(gap.from), width: x(gap.to) - x(gap.from) })),
  );
  const migrationX = migration && migration.timestampMs >= start && migration.timestampMs <= end ? x(migration.timestampMs) : null;
  return { candles, gaps, migrationX, start, end, highest, lowest };
}

export const PANES = Object.freeze({ labelBand: LABEL_BAND, priceTop: PRICE_TOP, priceBottom: PRICE_BOTTOM, volumeTop: VOLUME_TOP, volumeBottom: VOLUME_BOTTOM });
