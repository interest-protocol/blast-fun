import { quotePriceType, CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "../contracts/portfolio.ts";

/**
 * The display prices: blast-infra's, with the canonical TSUI quote at the
 * current SUI rate. Coins quoted in TSUI (sale pools and curves) are priced
 * by blast-infra itself. One row per coin type.
 *
 * Private on purpose: read it only by key, through `displayPriceOf` or
 * `displayPricesIn`. A join on its `coin_type` cannot push the key into the
 * union view, so Postgres builds the price of every coin on each statement,
 * and the estimate of a join to it multiplies until JIT compiles the plan
 * (Home's 57014s, 2026-11-28).
 */
const DISPLAY_PRICES = `(WITH test_sui_rate AS MATERIALIZED (
    SELECT usd_price, as_of_ms FROM chain_read_v1.prices
    WHERE coin_type = '${quotePriceType(CREATE_TEST_SUI_QUOTE_TYPE)}' AND usd_price > 0
      AND as_of_ms BETWEEN extract(epoch FROM statement_timestamp()) * 1000 - ${PORTFOLIO_PRICE_MAX_AGE_MS}
        AND extract(epoch FROM statement_timestamp()) * 1000
  )
  SELECT coin_type, usd_price, as_of_ms, source FROM chain_read_v1.prices
    WHERE coin_type <> '${CREATE_TEST_SUI_QUOTE_TYPE}'
  UNION ALL
  SELECT '${CREATE_TEST_SUI_QUOTE_TYPE}', usd_price, as_of_ms, 'test_sui_proxy'::text FROM test_sui_rate)`;

/**
 * One coin's display price as a lateral source (`coin_type`, `usd_price`,
 * `as_of_ms`, `source`), probed by `coin`, an SQL expression over the outer
 * row: `LEFT JOIN ${displayPriceOf("p.sale_token")} pr ON TRUE`. `when` skips
 * the probe for rows that do not use the price.
 *
 * The `LIMIT 1` is the fence that keeps this a per-row index probe: without
 * it the planner flattens the lateral back into a hash join over every
 * coin's price. It also keeps the estimate at one row per outer row.
 */
export function displayPriceOf(coin: string, when?: string): string {
  return `LATERAL (SELECT display_price.coin_type, display_price.usd_price, display_price.as_of_ms, display_price.source FROM ${DISPLAY_PRICES} display_price
    WHERE display_price.coin_type = ${coin}${when ? ` AND (${when})` : ""} LIMIT 1)`;
}

/** The display prices of the coin types in `coinTypes`, an SQL `text[]` expression. */
export function displayPricesIn(coinTypes: string): string {
  return `(SELECT display_price.coin_type, display_price.usd_price, display_price.as_of_ms, display_price.source FROM ${DISPLAY_PRICES} display_price WHERE display_price.coin_type = ANY(${coinTypes}))`;
}
