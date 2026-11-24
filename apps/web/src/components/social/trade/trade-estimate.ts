import { BLAST_TRADE_FEE_ESTIMATE_RATE } from "@blast/core/lib/blast-trade-fee.ts";
import { DEFAULT_TRADE_PROVIDERS, findCetusRoute, type TradeRouteAnswer, type TradeRouteRequest } from "@blast/core/modules/social/trades/cetus-route.ts";
import { priceRoute } from "@blast/core/modules/social/trades/route-quote.ts";
import { SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS, type SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";

import type { TradeQuoteRead } from "./trade-quotes";

/**
 * The browser's swap estimate: while the person types or taps a preset, the
 * number comes from Cetus's aggregator directly (it answers CORS), never from
 * our server. It is checked and priced by the same code as the server's quote
 * (`cetus-route.ts`, `route-quote.ts`), with the same providers and the 8-leg
 * rule, and Blast's fee at its published rate. It is shown, never traded: a
 * press asks the server for the sealed quote (`quote_id`), and the Undo
 * countdown runs on that.
 *
 * A coin in an Aftermath DAO-fee pool routes through that pool on the server
 * only, so its estimate is the server's; so is a pair Cetus cannot route now.
 */

export type TradeRouteFinder = (request: TradeRouteRequest) => Promise<TradeRouteAnswer>;

/** Cetus's aggregator, asked from the browser. */
export const findBrowserRoute: TradeRouteFinder = (request) =>
  findCetusRoute({ request, providers: DEFAULT_TRADE_PROVIDERS, fee: BLAST_TRADE_FEE_ESTIMATE_RATE });

/** A coin of the pair as the surface holds it: its USD price is a number (null without a fresh one). */
export type EstimateCoin = Readonly<{
  coinType: string;
  symbol: string;
  decimals: number;
  price: number | null;
  presale?: Readonly<{ venue: string }> | null;
}>;

/** A whole-dollar decimal for `atomsToUsd` (never exponent notation); null without a price. */
export function usdPriceText(price: number | null): string | null {
  if (price === null || !Number.isFinite(price) || price < 0 || price >= 1e21) return null;
  return price.toFixed(18).replace(/\.?0+$/, "");
}

/** A quote read whose answers are shown only: an offered one loses its `quote_id`, so nothing re-asks it before expiry and a press seals afresh. */
export function estimateOnly(read: TradeQuoteRead): TradeQuoteRead {
  return async (request, signal) => {
    const answer = await read(request, signal);
    return answer.status === "ok" && answer.quote.quote_id !== null ? { ...answer, quote: { ...answer.quote, quote_id: null, expires_at_ms: null } } : answer;
  };
}

/** The browser routes this pair itself (no server call); an Aftermath sale coin is priced only by the server. */
export function browserRoutable(coins: readonly EstimateCoin[]): boolean {
  return coins.every((coin) => coin.presale?.venue !== "aftermath");
}

/**
 * The estimate read for one pair: Cetus's route, priced in the browser; the
 * server's quote (shown only) for an Aftermath DAO-fee coin, an exact-out
 * request, or a pair Cetus does not route.
 */
export function tradeEstimateReader(input: Readonly<{
  findRoute: TradeRouteFinder;
  coins: readonly EstimateCoin[];
  /** Null: no server answer at all (the presets' read ahead); a pair the browser cannot route reads as an error. */
  fallback: TradeQuoteRead | null;
}>): TradeQuoteRead {
  const fallback = input.fallback === null ? async () => ({ status: "error" as const }) : estimateOnly(input.fallback);
  return async (request: SocialTradeQuoteRequest, signal) => {
    const inCoin = input.coins.find((coin) => coin.coinType === request.in_coin);
    const outCoin = input.coins.find((coin) => coin.coinType === request.out_coin);
    const amountIn = request.amount_in ?? null;
    if (!inCoin || !outCoin || amountIn === null || !browserRoutable([inCoin, outCoin])) {
      return fallback(request, signal);
    }
    const answer = await input.findRoute({ from: inCoin.coinType, target: outCoin.coinType, amount: BigInt(amountIn), byAmountIn: true, signal });
    if (answer.status !== "route") return signal?.aborted ? { status: "error" } : fallback(request, signal);
    const priced = priceRoute(
      { inCoin: inCoin.coinType, outCoin: outCoin.coinType, side: request.side, slippageBps: request.slippage_bps ?? SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS },
      answer.route,
      {
        in: { coinType: inCoin.coinType, symbol: inCoin.symbol, decimals: inCoin.decimals, usdPrice: usdPriceText(inCoin.price) },
        out: { coinType: outCoin.coinType, symbol: outCoin.symbol, decimals: outCoin.decimals, usdPrice: usdPriceText(outCoin.price) },
      },
      Date.now(),
      BLAST_TRADE_FEE_ESTIMATE_RATE.bps,
    );
    return { status: "ok", quote: priced.quote, routed: true };
  };
}

/**
 * A surface's estimate reads: `read` for what is typed or tapped (the server's answer, shown only, where the browser
 * has no route), `prefetchRead` for the presets read ahead (the browser's route only). Without a route finder (tests),
 * the server's answer, shown only, and no read ahead of its own.
 */
export function estimateReads(findRoute: TradeRouteFinder | undefined, coins: readonly EstimateCoin[], server: TradeQuoteRead): Readonly<{ read: TradeQuoteRead; prefetchRead?: TradeQuoteRead }> {
  if (!findRoute) return { read: estimateOnly(server) };
  return { read: tradeEstimateReader({ findRoute, coins, fallback: server }), prefetchRead: tradeEstimateReader({ findRoute, coins, fallback: null }) };
}
