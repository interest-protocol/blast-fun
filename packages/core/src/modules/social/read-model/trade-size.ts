import { TINY_TRADE_USD } from "../contracts/coin-market.ts";
import { CREATE_QUOTE_TYPE, createQuoteOf } from "../contracts/create.ts";

const USDC_ATOMS = 10n ** BigInt(createQuoteOf(CREATE_QUOTE_TYPE)!.decimals);

/**
 * True when the activity row `alias` is a trade proven under `usd` dollars (a
 * numeric SQL expression): USDC at par by its atoms, any other quote by its
 * recorded USD. A trade without that amount is never under, so `NOT` keeps it.
 * The web judges streamed trades the same way (`small-trades.ts`).
 */
export function tradeUnderUsdSql(alias: string, usd: string): string {
  return `(${alias}.kind IN ('trade_buy', 'trade_sell') AND CASE
      WHEN ${alias}.quote_type = '${CREATE_QUOTE_TYPE}' THEN coalesce(${alias}.quote_amount < ${usd} * ${USDC_ATOMS}::numeric, false)
      ELSE coalesce(${alias}.usd_value < ${usd}, false) END)`;
}

/** A tiny trade (`TINY_TRADE_USD`): no list shows it and no count counts it; volume sums it. */
export function tinyTradeSql(alias: string): string {
  return tradeUnderUsdSql(alias, `${TINY_TRADE_USD}::numeric`);
}
