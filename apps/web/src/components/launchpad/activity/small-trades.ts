import { SMALL_TRADE_USD } from "@blast/core/web/contracts/coin-market.ts";
import { CREATE_QUOTE_TYPE, quotePriceType } from "@blast/core/web/contracts/create.ts";
import type { HomeEvent } from "@blast/core/web/contracts/home.ts";
import { compareExact, exactAtoms, exactDecimal, multiplyExact, type Exact } from "@blast/core/web/exact-amount.ts";

const SMALL_TRADE: Exact = { n: BigInt(SMALL_TRADE_USD), scale: 0 };

function isSmall(usd: Exact): boolean {
  return compareExact(usd, SMALL_TRADE) < 0;
}

export function isTradeUnderDollar({ usd, quote, decimals, quoteUsd }: Readonly<{
  usd?: string | null;
  quote?: bigint | string;
  decimals?: number | null;
  quoteUsd?: string | null;
}>): boolean {
  const recorded = exactDecimal(usd);
  if (recorded) {
    return isSmall(recorded);
  }
  const rate = exactDecimal(quoteUsd);
  const amount = exactAtoms(quote, decimals);
  return rate !== null && rate.n > 0n && amount !== null && isSmall(multiplyExact(amount, rate));
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

export function isHomeTradeUnderDollar(quote: HomeEvent["quote"]): boolean {
  if (!quote) {
    return false;
  }
  // USDC is shown at par. Its atoms also resolve history rounded to $1.00.
  if (quotePriceType(quote.quote_type) === CREATE_QUOTE_TYPE && quote.quote_decimals !== null) {
    return isTradeUnderDollar({ quote: quote.atoms, decimals: quote.quote_decimals, quoteUsd: "1" });
  }
  return quote.usd_complete && isTradeUnderDollar({ usd: quote.usd });
}
