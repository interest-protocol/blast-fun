/**
 * One coin's `chain_read_v1.prices` row as a lateral source (`coin_type`,
 * `usd_price`, `as_of_ms`), probed by `coin`, an SQL expression over
 * the outer row: `LEFT JOIN ${chainPriceOf("h.coin_type")} pr ON TRUE`.
 *
 * Never join the view on `coin_type`: Postgres cannot push a join key into
 * its union, so it prices every coin on each statement. The `LIMIT 1` fences
 * the lateral so the planner keeps it a per-row probe instead of flattening it
 * back into that join, and keeps the estimate at one row per outer row.
 */
export function chainPriceOf(coin: string): string {
  return `LATERAL (SELECT chain_price.coin_type, chain_price.usd_price, chain_price.as_of_ms FROM chain_read_v1.prices chain_price
    WHERE chain_price.coin_type = ${coin} LIMIT 1)`;
}
