import pg from "pg";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { INDEXED_POOL_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";

const TRACKED_POOL_VALUES = INDEXED_POOL_COINS.map((coin) => {
  const separator = coin.poolKey.indexOf(":");
  const venue = coin.poolKey.slice(0, separator);
  const poolId = coin.poolKey.slice(separator + 1);
  const fields = [coin.coinType, coin.symbol, coin.name, coin.logoUrl, venue, poolId];
  return `(${fields.map(pg.escapeLiteral).join(",")},${coin.decimals})`;
}).join(",\n");

const TRACKED_POOL_SOURCE = `UNION ALL
    SELECT t.sale_token,t.sale_symbol,t.sale_name,t.sale_icon_url,t.sale_decimals,t.venue,t.pool_id,
      ${pg.escapeLiteral(SUI_COIN_TYPE)},'SUI',9,TRUE,NULL,NULL,NULL,NULL
    FROM (VALUES ${TRACKED_POOL_VALUES}) t(sale_token,sale_symbol,sale_name,sale_icon_url,venue,pool_id,sale_decimals)`;

/** Presales retain priority even when hidden, followed by the earliest eligible native launch vault. */
function homeCoinSources(trackedPools: string): string {
  return `(SELECT p.presale_id AS source_id,p.presale_id,p.sale_token,p.sale_symbol,p.sale_name,p.sale_icon_url,
  p.sale_decimals,p.lifecycle,p.venue,p.pool_id,p.quote_type,p.quote_symbol,p.quote_decimals,
  p.start_ms,p.end_ms,p.raise_target,p.total_commitments,p.participants,FALSE AS tracked_pool_only
  FROM ${SHOWN_PRESALES} p
  UNION ALL
  (SELECT DISTINCT ON (c.sale_token) c.sale_token,NULL::text,c.sale_token,c.sale_symbol,c.sale_name,c.sale_icon_url,
    c.sale_decimals,'migrated'::text,c.venue,c.pool_id,c.quote_type,c.quote_symbol,c.quote_decimals,
    NULL::bigint,NULL::bigint,NULL::numeric,NULL::numeric,NULL::bigint,c.tracked_pool_only
  FROM (
    SELECT v.meme_type AS sale_token,coalesce(m.symbol,m.name,v.meme_type) AS sale_symbol,
      coalesce(m.name,m.symbol,v.meme_type) AS sale_name,m.icon_url AS sale_icon_url,m.decimals AS sale_decimals,
      v.venue,v.pool_id,v.quote_type,q.symbol AS quote_symbol,q.decimals AS quote_decimals,
      FALSE AS tracked_pool_only,v.created_checkpoint,v.created_tx_slot,v.created_event_slot,v.vault_id
    FROM chain_read_v1.vaults v
    JOIN chain_read_v1.coin_metadata m ON m.coin_type=v.meme_type
    JOIN chain_read_v1.coin_metadata q ON q.coin_type=v.quote_type
    WHERE v.origin_kind='launch' AND m.decimals IS NOT NULL AND q.decimals IS NOT NULL AND q.symbol IS NOT NULL
    ${trackedPools}
  ) c
  WHERE NOT EXISTS (SELECT 1 FROM chain_read_v1.presales p WHERE p.sale_token=c.sale_token)
  ORDER BY c.sale_token,c.tracked_pool_only,c.created_checkpoint,c.created_tx_slot,c.created_event_slot,c.vault_id))`;
}

/** Market detail and trade feeds require coverage from a launch or a presale. */
export const HOME_COIN_SOURCES = homeCoinSources("");
/** Discover and saved-coin reads also expose tracked pools with partial market coverage. */
export const HOME_LIST_COIN_SOURCES = homeCoinSources(TRACKED_POOL_SOURCE);
