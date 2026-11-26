import { quotePriceType, CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "../contracts/portfolio.ts";

/**
 * The display prices: blast-infra's, with the canonical TSUI quote at the
 * current SUI rate. Coins quoted in TSUI (sale pools and curves) are priced
 * by blast-infra itself.
 */
export const DISPLAY_PRICES = `(WITH test_sui_rate AS MATERIALIZED (
    SELECT usd_price, as_of_ms FROM chain_read_v1.prices
    WHERE coin_type = '${quotePriceType(CREATE_TEST_SUI_QUOTE_TYPE)}' AND usd_price > 0
      AND as_of_ms BETWEEN extract(epoch FROM statement_timestamp()) * 1000 - ${PORTFOLIO_PRICE_MAX_AGE_MS}
        AND extract(epoch FROM statement_timestamp()) * 1000
  )
  SELECT coin_type, usd_price, as_of_ms, source FROM chain_read_v1.prices
    WHERE coin_type <> '${CREATE_TEST_SUI_QUOTE_TYPE}'
  UNION ALL
  SELECT '${CREATE_TEST_SUI_QUOTE_TYPE}', usd_price, as_of_ms, 'test_sui_proxy'::text FROM test_sui_rate)`;
