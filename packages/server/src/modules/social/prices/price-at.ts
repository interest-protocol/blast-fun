const PRICE_AT_LOOKBACK_MS = 3_600_000;

/** Latest observed 5m USD price in the hour leading up to a cutoff. */
export function recentPriceAtSql(coin: string, cutoff: string, requirePositive = false): string {
  return `SELECT ph.usd_price, ph.as_of_ms, ph.bucket_ms
    FROM chain_read_v1.price_history ph
    WHERE ph.coin_type = ${coin} AND ph.resolution = '5m'
      AND ph.bucket_ms > ${cutoff} - ${PRICE_AT_LOOKBACK_MS} AND ph.bucket_ms <= ${cutoff} AND ph.as_of_ms <= ${cutoff}
      ${requirePositive ? "AND ph.usd_price > 0" : ""}
    ORDER BY ph.bucket_ms DESC LIMIT 1`;
}

/** USD price at a window's cutoff: the last price at or before it, optionally shortened to the first priced observation. */
export function rollingPriceAtSql(coin: string, cutoff: string, windowEnd?: string): string {
  // Prefer the indexer's price at the cutoff even when no trades happened in the preceding hour.
  const prior = `WITH native AS MATERIALIZED (
    SELECT usd_price, as_of_ms FROM chain_read_v1.native_coin_price_at(${coin}, ${cutoff})
  ), prior AS MATERIALIZED (
    SELECT usd_price, as_of_ms, as_of_ms AS bucket_ms FROM native
    UNION ALL
    SELECT recent.* FROM (${recentPriceAtSql(coin, cutoff, true)}) recent WHERE NOT EXISTS (SELECT 1 FROM native)
  )`;
  if (windowEnd === undefined) return `${prior} SELECT * FROM prior`;

  return `${prior}
  SELECT * FROM prior
  UNION ALL
  SELECT usd_price, as_of_ms, as_of_ms AS bucket_ms
  FROM chain_read_v1.coin_price_in_window(${coin}, ${cutoff}, ${windowEnd}, TRUE)
  WHERE NOT EXISTS (SELECT 1 FROM prior)`;
}

/** Latest dated USD observation newer than the current projection. */
export function latestWindowPriceSql(coin: string, from: string, to: string): string {
  return `SELECT usd_price, as_of_ms FROM chain_read_v1.coin_price_in_window(${coin}, ${from}, ${to}, FALSE)`;
}
