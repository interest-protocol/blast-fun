import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { PresalePoolSwap } from "@blast/core/modules/live/presale-market-frames.ts";
import { compareExact, divideExact, exactDecimal, exactText } from "@blast/core/web/exact-amount.ts";
import { PRICE_WINDOW_MS } from "@blast/core/web/contracts/prices.ts";
import { TRADE_CANDLE_LIMIT, type TradeCandlePage } from "@blast/core/web/contracts/trade-candles.ts";
import type { ChartCandlePage } from "#web/components/launchpad/chart/chart-model.ts";

export function poolFill(frame: PresalePoolSwap) {
  const volume = BigInt(frame.quote_atoms);
  const amount = BigInt(frame.coin_atoms);
  const price = divideExact({ n: volume, scale: 0 }, { n: amount, scale: 0 }, 36)!;
  return {
    cursor: frame.cursor,
    checkpoint: Number(frame.cursor.split(":", 1)[0]),
    time: frame.timestamp_ms,
    price,
    volume,
    amount,
    side: frame.side,
    receivedAt: performance.now(),
  };
}

/** A committed snapshot already includes every fill through its checkpoint. */
export function overlayPoolFills(history: ChartCandlePage, page: TradeCandlePage, fills: readonly ReturnType<typeof poolFill>[]): ChartCandlePage {
  const width = candleIntervalMs(history.interval);
  const candles = new Map(history.candles.map((candle) => [candle.bucketStart, candle]));
  let changed = false;
  for (const fill of fills) {
    if (fill.checkpoint <= page.as_of.checkpoint || fill.time < page.from_ms) continue;
    const bucketStart = fill.time - fill.time % width;
    const price = exactText(fill.price);
    const previous = candles.get(bucketStart);
    candles.set(bucketStart, previous ? {
      ...previous,
      high: compareExact(fill.price, exactDecimal(previous.high)!) > 0 ? price : previous.high,
      low: compareExact(fill.price, exactDecimal(previous.low)!) < 0 ? price : previous.low,
      close: price,
      volumeQuote: previous.volumeQuote + fill.volume,
      trades: previous.trades + 1,
    } : { bucketStart, open: price, high: price, low: price, close: price, volumeQuote: fill.volume, trades: 1 });
    changed = true;
  }
  if (!changed) return history;
  const ordered = [...candles.values()].sort((a, b) => a.bucketStart - b.bucketStart);
  const end = Math.max(page.to_ms, fills.at(-1)?.time ?? 0);
  const start = page.window === "launch" ? page.from_ms : Math.max(page.from_ms, end - PRICE_WINDOW_MS[page.window]);
  const inRange = ordered.filter(({ bucketStart }) => bucketStart + width > start);
  return { ...history, candles: inRange.slice(-TRADE_CANDLE_LIMIT), truncated: history.truncated || inRange.length > TRADE_CANDLE_LIMIT };
}
