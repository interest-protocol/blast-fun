import { CREATE_QUOTE_TYPE, quotePriceType } from "@blast/core/web/contracts/create.ts";
import type { HomeEvent } from "@blast/core/web/contracts/home.ts";
import { atLeastPow10, exactAtoms, exactDecimal, multiplyExact } from "@blast/core/web/exact-amount.ts";

export function isTradeUnderDollar({ usd, quote, decimals, quoteUsd }: Readonly<{
  usd?: string | null;
  quote?: bigint | string;
  decimals?: number | null;
  quoteUsd?: string | null;
}>): boolean {
  const recorded = exactDecimal(usd);
  if (recorded) {
    return !atLeastPow10(recorded, 0);
  }
  const rate = exactDecimal(quoteUsd);
  const amount = exactAtoms(quote, decimals);
  return rate !== null && rate.n > 0n && amount !== null && !atLeastPow10(multiplyExact(amount, rate), 0);
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
