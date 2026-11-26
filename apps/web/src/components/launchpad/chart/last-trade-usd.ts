import { exactAtoms, exactDecimal, exactText, multiplyExact } from "@blast/core/web/exact-amount.ts";
import { quotePriceType } from "@blast/core/web/contracts/create.ts";
import { readableUsd } from "#web/lib/market-format.ts";

/**
 * The trade in dollars when the page shows USD: its recorded value, else its quote amount at the
 * page's rate when the trade is in the page's quote. Null keeps the quote amount.
 */
export function lastTradeUsd(
  quoteAmount: bigint,
  recordedUsd: string | null | undefined,
  source: Readonly<{ quoteType?: string | null; decimals: number | null }>,
  currency: Readonly<{ currency: "usd" | "quote"; quoteType: string | null; quoteUsd: string | null }> | null,
): string | null {
  if (currency?.currency !== "usd") return null;
  if (recordedUsd && exactDecimal(recordedUsd)) return readableUsd(recordedUsd);
  // Only a trade known to be in the page's quote takes the page's rate.
  const samePair = !!source.quoteType && currency.quoteType !== null && quotePriceType(source.quoteType) === quotePriceType(currency.quoteType);
  const rate = samePair ? exactDecimal(currency.quoteUsd) : null;
  const amount = exactAtoms(quoteAmount, source.decimals);
  return rate && amount ? readableUsd(exactText(multiplyExact(amount, rate))) : null;
}
