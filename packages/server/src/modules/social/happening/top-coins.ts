import { tinyTradeSql } from "@blast/core/modules/social/read-model/trade-size.ts";
import { optionalSource } from "../optional-source.ts";
import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { PUBLIC_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { VIEWER_STATE_MAX_IDS } from "@blast/core/modules/social/contracts/viewer-state.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import type { HappeningCoin, TopCoins } from "@blast/core/modules/social/contracts/happening.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";

/** Counts are Blast accounts, including private accounts, never their identities. SUI has no indexed counts. */
export const TOP_COINS_SQL = `SELECT market.* FROM (WITH shown_coins AS MATERIALIZED (
  SELECT p.sale_token AS coin_type, p.presale_id, coalesce(p.sale_name,'') AS name, coalesce(p.sale_symbol,'') AS symbol, p.sale_icon_url AS icon_url,
    coalesce(trust.verified_team, false) AS verified_team
  FROM ${PUBLIC_PRESALES} p LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id WHERE p.lifecycle = 'migrated'
  UNION ALL SELECT '${SOCIAL_TRADE_BASE_COINS.sui}', NULL, 'Sui', 'SUI', NULL, false
), priced AS MATERIALIZED (
  SELECT c.*, trim_scale(pr.usd_price)::text AS price_usd
  FROM shown_coins c JOIN ${DISPLAY_PRICES} pr ON pr.coin_type = c.coin_type
  WHERE pr.usd_price > 0 AND pr.as_of_ms >= $2::bigint - ${PORTFOLIO_PRICE_MAX_AGE_MS} AND pr.as_of_ms <= $2::bigint
), counted_coins AS MATERIALIZED (
  -- Keep distinct-account sort keys narrow even when canonical coin types are long.
  SELECT coin_type, row_number() OVER () AS coin_key
  FROM (SELECT DISTINCT coin_type FROM priced WHERE presale_id IS NOT NULL) distinct_coins
), buyers AS (
  SELECT c.coin_key, count(DISTINCT o.account_id)::int AS total
  FROM chain_read_v1.activity a
  JOIN counted_coins c ON c.coin_type = a.coin_type
  JOIN social_wallet_owners o ON o.address = a.actor
  WHERE a.kind = 'trade_buy' AND NOT ${tinyTradeSql("a")} AND a.timestamp_ms > $1::bigint - 86400000 AND a.timestamp_ms <= $1::bigint
    AND a.checkpoint <= $3::bigint
  GROUP BY c.coin_key
), holders AS (
  SELECT c.coin_key, count(DISTINCT o.account_id)::int AS total
  FROM chain_read_v1.coin_balances b
  JOIN counted_coins c ON c.coin_type = b.coin_type
  JOIN social_wallet_owners o ON o.address = b.owner
  WHERE b.balance > 0
  GROUP BY c.coin_key
)
SELECT c.*,
  (SELECT trim_scale(ph.usd_price)::text FROM chain_read_v1.price_history ph
    WHERE ph.coin_type = c.coin_type AND ph.resolution = '5m'
      AND ph.bucket_ms > $1::bigint - 90000000 AND ph.bucket_ms <= $1::bigint - 86400000
      AND ph.as_of_ms <= $1::bigint - 86400000
    ORDER BY ph.bucket_ms DESC LIMIT 1) AS price_24h_usd,
  CASE WHEN c.presale_id IS NULL THEN NULL ELSE coalesce(b.total, 0) END AS buyers_24h,
  CASE WHEN c.presale_id IS NULL THEN NULL ELSE coalesce(h.total, 0) END AS holders
FROM priced c
LEFT JOIN counted_coins k ON k.coin_type = c.coin_type
LEFT JOIN buyers b ON b.coin_key = k.coin_key
LEFT JOIN holders h ON h.coin_key = k.coin_key) market`;

const ratio = (coin: HappeningCoin) => coin.buyers_24h === null || coin.holders === null ? -1 : coin.holders > 0 ? coin.buyers_24h / coin.holders : 0;

export function rankTopCoins(coins: readonly HappeningCoin[]): TopCoins {
  return {
    trending: [...coins].sort((a, b) => ratio(b) - ratio(a) || a.coin_type.localeCompare(b.coin_type)).slice(0, VIEWER_STATE_MAX_IDS),
    gainers: coins.filter((coin) => coin.change_24h_bps !== null && coin.change_24h_bps > 0)
      .sort((a, b) => b.change_24h_bps! - a.change_24h_bps! || a.coin_type.localeCompare(b.coin_type)).slice(0, VIEWER_STATE_MAX_IDS),
  };
}

export function readTopCoins(db: ReadableDatabase, clockMs: number, nowMs: number, marketCheckpoint: number): Promise<TopCoins | null> {
  return optionalSource("top_coins", () => readRankedCoins(db, clockMs, nowMs, marketCheckpoint), null);
}

async function readRankedCoins(db: ReadableDatabase, clockMs: number, nowMs: number, marketCheckpoint: number): Promise<TopCoins> {
  const { rows } = await db.read<Omit<HappeningCoin, "change_24h_bps"> & { price_24h_usd: string | null }>(TOP_COINS_SQL, [clockMs, nowMs, marketCheckpoint]);
  return rankTopCoins(rows.map(({ price_24h_usd, verified_team, ...coin }) => ({ ...coin, ...(verified_team ? { verified_team } : {}), change_24h_bps: changeBps(coin.price_usd, price_24h_usd) })));
}
