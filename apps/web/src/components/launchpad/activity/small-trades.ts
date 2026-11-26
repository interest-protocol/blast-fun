import { SMALL_TRADE_USD, TINY_TRADE_USD } from "@blast/core/web/contracts/coin-market.ts";
import { CREATE_QUOTE_TYPE, quotePriceType } from "@blast/core/web/contracts/create.ts";
import type { HomeEvent } from "@blast/core/web/contracts/home.ts";
import { compareExact, exactAtoms, exactDecimal, multiplyExact, type Exact } from "@blast/core/web/exact-amount.ts";

/** Dust: what the "Hide trades under $1" switch hides. */
export const SMALL_TRADE: Exact = { n: BigInt(SMALL_TRADE_USD), scale: 0 };
/** Tiny: hidden from every trades list whatever the switch says, as the server drops them (`trade-size.ts`). */
export const TINY_TRADE: Exact = exactDecimal(TINY_TRADE_USD)!;

/** The "Hide trades under $1" switch's state, owned by whatever reads the trades. */
export type SmallTradeFilter = readonly [boolean, (hide: boolean) => void];

/** The floor a list hides trades under: dust with the switch on, else only tiny trades. */
export const tradeFloor = (hideSmallTrades: boolean): Exact => hideSmallTrades ? SMALL_TRADE : TINY_TRADE;

/** True when the trade is proven under `floor` dollars (default $1); a trade without a known size never is. */
export function isTradeUnderDollar({ usd, quote, decimals, quoteUsd }: Readonly<{
  usd?: string | null;
  quote?: bigint | string;
  decimals?: number | null;
  quoteUsd?: string | null;
}>, floor: Exact = SMALL_TRADE): boolean {
  const recorded = exactDecimal(usd);
  if (recorded) {
    return compareExact(recorded, floor) < 0;
  }
  const rate = exactDecimal(quoteUsd);
  const amount = exactAtoms(quote, decimals);
  return rate !== null && rate.n > 0n && amount !== null && compareExact(multiplyExact(amount, rate), floor) < 0;
}

/**
 * USD for one whole quote coin, as the trades lists price dust: USDC at par,
 * else the page's rate for that quote, else `fallback`.
 */
export function dustQuoteUsd(
  quoteType: string | null | undefined,
  currency: Readonly<{ quoteType: string | null; rate: string | null }> | null,
  fallback?: string | null,
): string | null {
  const type = quoteType ? quotePriceType(quoteType) : null;
  if (type === CREATE_QUOTE_TYPE) return "1";
  const rate = currency?.quoteType && type === quotePriceType(currency.quoteType) ? currency.rate : null;
  return rate ?? fallback ?? null;
}

export function isHomeTradeUnderDollar(quote: HomeEvent["quote"], floor: Exact = SMALL_TRADE): boolean {
  if (!quote) {
    return false;
  }
  // USDC is shown at par. Its atoms also resolve history rounded to $1.00.
  if (quotePriceType(quote.quote_type) === CREATE_QUOTE_TYPE && quote.quote_decimals !== null) {
    return isTradeUnderDollar({ quote: quote.atoms, decimals: quote.quote_decimals, quoteUsd: "1" }, floor);
  }
  return quote.usd_complete && isTradeUnderDollar({ usd: quote.usd }, floor);
}
