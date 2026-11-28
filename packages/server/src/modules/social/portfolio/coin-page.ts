import { chainPriceOf } from "@blast/core/modules/social/prices/keyed.ts";
import { verifiedTeamSql } from "@blast/server/modules/social/read-model/verified-team.ts";
import { CORE_COINS, PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_COINS_PAGE_SIZE, PORTFOLIO_PRICE_MAX_AGE_MS, type PortfolioCoinPage } from "@blast/core/modules/social/contracts/portfolio.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { BLAST_LAUNCH_COINS, TEST_SUI_COIN_TYPES_SQL } from "../read-model/blast-launch-coins.ts";

/** Aggregate linked wallets before filtering, ranking and limiting; prices never exclude a holding. */
export async function readPortfolioCoinPage(db: ReadableDatabase, addresses: readonly string[], page: number, search: string, nowMs: number, hideSmall = false): Promise<PortfolioCoinPage> {
  const { rows } = await db.read<{ total: number; page: number; wallet_has_coins: boolean; coins: PortfolioCoinPage["coins"] }>(`
    SELECT * FROM (WITH held AS MATERIALIZED (
      SELECT b.coin_type, sum(b.balance)::numeric AS balance
      FROM (SELECT DISTINCT unnest((SELECT $1::text[])) AS owner) w
      JOIN chain_read_v1.wallet_balances b USING (owner)
      GROUP BY b.coin_type HAVING sum(b.balance) > 0
    ), priced AS (
      SELECT h.coin_type, h.balance::text, h.coin_type = ANY($8::text[]) AS is_core,
        array_position($10::text[], h.coin_type) AS preferred_order,
        coalesce(CASE WHEN m.symbol IS DISTINCT FROM $9::jsonb->h.coin_type->>'symbol' THEN $9::jsonb->h.coin_type->>'name' END,m.name,p.sale_name,$11::jsonb->h.coin_type->>'name') AS name,
        coalesce($9::jsonb->h.coin_type->>'symbol',m.symbol,p.sale_symbol,split_part(split_part(h.coin_type,'<',1),'::',3)) AS symbol,
        d.decimals, coalesce(m.icon_url,p.sale_icon_url,$11::jsonb->h.coin_type->>'logoUrl') AS icon_url, p.presale_id,
        ${verifiedTeamSql("p.presale_id", "h.coin_type")} AS verified_team,
        CASE WHEN h.coin_type IN (${TEST_SUI_COIN_TYPES_SQL}) THEN 0::numeric
          WHEN h.coin_type = $6 THEN h.balance * 0.000001::numeric
          WHEN EXISTS (SELECT 1 FROM chain_read_v1.coin_unavailable WHERE coin_type = h.coin_type) THEN NULL
          WHEN pr.as_of_ms >= $4::bigint - ${PORTFOLIO_PRICE_MAX_AGE_MS} AND d.decimals IS NOT NULL
          THEN h.balance * pr.usd_price * ('1e-' || d.decimals)::numeric END AS value_usd_exact
      FROM held h
      LEFT JOIN LATERAL (SELECT * FROM chain_read_v1.coin_metadata WHERE coin_type = h.coin_type OFFSET 0) m ON TRUE
      LEFT JOIN LATERAL (SELECT presale_id,sale_name,sale_symbol,sale_decimals,sale_icon_url,quote_type,pool_id
        FROM ${SHOWN_PRESALES} p WHERE p.sale_token = h.coin_type LIMIT 1) p ON TRUE
      LEFT JOIN ${chainPriceOf("h.coin_type")} pr ON TRUE
      CROSS JOIN LATERAL (SELECT CASE h.coin_type WHEN $5 THEN 9 WHEN $6 THEN 6 ELSE coalesce(m.decimals,p.sale_decimals,($11::jsonb->h.coin_type->>'decimals')::int)::int END AS decimals) d
    ), valued AS (
      SELECT *, round(value_usd_exact,2) AS value_usd FROM priced
    ), matches AS MATERIALIZED (
      -- A row shows its name, ticker and coin type, so a term matches those. It reaches inside the coin type only
      -- when it is written as one (0x…, :: or an address of 6+ hex digits pasted without 0x), never a stray hex pair.
      SELECT * FROM valued WHERE (NOT $7::boolean OR is_core OR decimals IS NULL OR balance::numeric >= power(10::numeric,decimals)) AND (strpos(lower(coalesce(name,'')),lower($3)) > 0
        OR strpos(lower(symbol),lower($3)) > 0 OR strpos(lower(coalesce($9::jsonb->coin_type->>'symbol','')),lower($3)) > 0 OR ((lower($3) LIKE '0x%' OR strpos($3,'::') > 0 OR $3 ~* '^[0-9a-f]{6,}$') AND strpos(lower(coin_type),lower($3)) > 0))
    ), bounds AS (
      SELECT count(*)::int AS total,
        least($2::int,greatest(1,ceil(count(*)::numeric / ${PORTFOLIO_COINS_PAGE_SIZE})::int)) AS page FROM matches
    ), slice AS (
      SELECT * FROM matches ORDER BY value_usd DESC NULLS LAST,preferred_order ASC NULLS LAST,is_core DESC,coin_type ASC
      LIMIT ${PORTFOLIO_COINS_PAGE_SIZE} OFFSET (SELECT (page-1)*${PORTFOLIO_COINS_PAGE_SIZE} FROM bounds)
    ), linked AS (
      -- Only the page's rows look up their launch: at most one indexed probe per shown coin.
      SELECT s.*, c.launch_id FROM slice s
      LEFT JOIN LATERAL (SELECT c.launch_id FROM ${BLAST_LAUNCH_COINS} c WHERE c.coin_type = s.coin_type AND c.launch_id IS NOT NULL ORDER BY c.launch_id LIMIT 1) c ON TRUE
    )
    SELECT total,page,exists(SELECT 1 FROM held) AS wallet_has_coins,coalesce((SELECT jsonb_agg(jsonb_build_object(
      'coin_type',coin_type,'balance',balance,'name',name,'symbol',symbol,'decimals',decimals,
      'icon_url',icon_url,'presale_id',presale_id,'launch_id',launch_id,'value_usd',value_usd::text,
      'value_usd_exact',trim_scale(value_usd_exact)::text
    ) || CASE WHEN verified_team THEN '{"verified_team":true}'::jsonb ELSE '{}'::jsonb END ORDER BY value_usd DESC NULLS LAST,preferred_order ASC NULLS LAST,is_core DESC,coin_type ASC) FROM linked),'[]'::jsonb) AS coins FROM bounds) AS coin_page`,
  [[...addresses], page, search, nowMs, PORTFOLIO_COIN_TYPES.sui, PORTFOLIO_COIN_TYPES.usdc, hideSmall, CORE_COINS.map(coin => coin.coinType), Object.fromEntries(CORE_COINS.map(coin => [coin.coinType, { symbol: coin.symbol, name: coin.name }])), PREFERRED_COINS.map(coin => coin.coinType), Object.fromEntries(PREFERRED_COINS.map(coin => [coin.coinType, coin]))]);
  const row = rows[0];
  if (!row) throw new TypeError("The coin page query always returns its count.");
  return { ...row, page_size: PORTFOLIO_COINS_PAGE_SIZE };
}
