import {
  tradeCandlePageSchema,
  type TradeCandlePage,
} from "@blast/core/web/contracts/trade-candles.ts";
import {
  candleIntervalMs,
  type CandleInterval,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";
import {
  PRICE_WINDOW_MS,
  priceTierFor,
  type PriceWindow,
} from "@blast/core/web/contracts/prices.ts";
import { compareDecimal } from "@blast/core/modules/social/items/decimal.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { addExact, divideExact, exactAtoms, exactDecimal, exactText } from "@blast/core/lib/exact-amount.ts";
import { coinKey } from "#web/components/launchpad/market-stream-hub.ts";
import type { CoinAsset } from "./coin-reads";
import type { TradeQuote } from "./coin-market-history";

export type TradeCoinHistory = Readonly<{
  kind: "trades";
  coin_type: string;
  page: TradeCandlePage;
}>;

export async function tradeCoinHistory(
  asset: CoinAsset,
  window: PriceWindow,
  signal: AbortSignal,
  interval?: CandleInterval,
  at?: number,
): Promise<TradeCoinHistory | null> {
  signal.throwIfAborted();
  if (asset.network !== "mainnet") return null;
  const selected =
    interval ??
    priceTierFor(
      window === "launch" ? PRICE_WINDOW_MS["24h"] : PRICE_WINDOW_MS[window],
    );
  const params = new URLSearchParams({
    format: "ohlcv",
    source: "pool_swaps",
    coin: asset.coin_type,
    window,
    interval: selected,
  });
  if (asset.presale_id) params.set("presale", asset.presale_id);
  if (at !== undefined) params.set("at", String(at));
  try {
    const response = await fetch(`/api/social/prices?${params}`, {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) return null;
    const page = tradeCandlePageSchema.parse(await response.json());
    if (
      page.coin_type !== asset.coin_type ||
      page.window !== window ||
      page.interval !== selected ||
      (asset.presale_id && page.presale_id !== asset.presale_id) ||
      page.status === "unsupported" ||
      page.as_of.checkpoint < (at ?? 0)
    )
      return null;
    const width = candleIntervalMs(selected);
    if (
      page.candles.some(
        (candle, index) =>
          candle.at_ms % width !== 0 ||
          candle.at_ms < page.from_ms ||
          candle.at_ms > page.to_ms ||
          (index > 0 && candle.at_ms <= page.candles[index - 1]!.at_ms) ||
          compareDecimal(candle.low, candle.high) > 0 ||
          [candle.open, candle.close].some(
            (value) =>
              compareDecimal(value, candle.low) < 0 ||
              compareDecimal(value, candle.high) > 0,
          ),
      )
    )
      return null;
    if (page.status !== "available" && page.candles.length > 0) return null;
    if (page.status === "available" && !page.quote) return null;
    return { kind: "trades", coin_type: asset.coin_type, page };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return null;
  }
}

/** One pool swap the market stream carried, with the decimals its frame's pool summary gave. */
export type StreamedFill = Readonly<{
  checkpoint: number;
  timestampMs: number;
  quoteAmount: bigint;
  memeAmount: bigint;
  quote: TradeQuote | null;
}>;

/** The pool a migrated coin's swap candles come from, as the market stream names it; null without one it streams. */
export function tradePoolKey(history: TradeCoinHistory): string | null {
  const pool = history.page.pool;
  const key = pool ? `${pool.venue}:${pool.id}` : null;
  return key && POOL_KEY.test(key) ? key : null;
}

/**
 * One streamed swap on the swap candles, by the server's own rule (`candleAggregation`): price is
 * `quote_amount × 10^sale_decimals ÷ coin_amount ÷ 10^quote_decimals`, volume is quote tokens.
 * A swap in another quote, or with nothing to price it, leaves the candles as they are.
 */
export function applyStreamedFill(history: TradeCoinHistory, fill: StreamedFill): TradeCoinHistory {
  const { page } = history;
  if (page.source !== "chain_pool_swaps" || page.status !== "available" || !page.quote || !fill.quote) return history;
  if (coinKey(fill.quote.quote) !== coinKey(page.quote.coin_type)) return history;
  const quote = exactAtoms(fill.quoteAmount, fill.quote.quoteDecimals);
  const meme = exactAtoms(fill.memeAmount, fill.quote.memeDecimals);
  if (!quote || !meme || quote.n <= 0n || meme.n <= 0n) return history;
  const ratio = divideExact(quote, meme);
  if (!ratio) return history;
  const price = exactText(ratio);
  const volume = exactText(quote);
  const width = candleIntervalMs(page.interval);
  const at = fill.timestampMs - (fill.timestampMs % width);
  const last = page.candles.at(-1);
  if (last && at < last.at_ms) return history;
  const candle =
    last?.at_ms === at
      ? {
          ...last,
          high: compareDecimal(price, last.high) > 0 ? price : last.high,
          low: compareDecimal(price, last.low) < 0 ? price : last.low,
          close: price,
          volume: exactText(addExact(exactDecimal(last.volume)!, quote)),
          trades: last.trades + 1,
        }
      : { at_ms: at, open: price, high: price, low: price, close: price, volume, trades: 1 };
  const candles = last?.at_ms === at ? [...page.candles.slice(0, -1), candle] : [...page.candles, candle];
  return { ...history, page: { ...page, candles, to_ms: Math.max(page.to_ms, fill.timestampMs) } };
}
