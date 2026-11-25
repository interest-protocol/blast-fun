import pg from "pg";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { INDEXED_POOL_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { HOME_ALMOST_GRADUATED_BPS } from "@blast/core/modules/social/contracts/home.ts";

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

/**
 * Bonding curves still filling (`live`, `migration_ready`): blast-infra
 * creates a launch vault only when a curve migrates, so these have none yet.
 * The opening round is left out: its price is not public until it closes.
 * Their source lifecycle is `migrated` like every listed coin (it means
 * "has a market"); the curve's own lifecycle reaches the item as
 * `HomeCoin.curve.lifecycle` through the facts read. `where` narrows them.
 */
const liveCurves = (where = "") => `SELECT lp.coin_type AS sale_token,coalesce(m.symbol,m.name,lp.coin_type) AS sale_symbol,
      coalesce(m.name,m.symbol,lp.coin_type) AS sale_name,m.icon_url AS sale_icon_url,m.decimals AS sale_decimals,
      lp.venue,lp.pool_id,lp.quote_type,q.symbol AS quote_symbol,q.decimals AS quote_decimals,FALSE AS tracked_pool_only,
      lp.created_checkpoint,NULL AS created_tx_slot,NULL AS created_event_slot,NULL AS vault_id
    FROM chain_read_v1.pools lp
    JOIN chain_read_v1.coin_metadata m ON m.coin_type=lp.coin_type
    JOIN chain_read_v1.coin_metadata q ON q.coin_type=lp.quote_type
    WHERE lp.venue='blast_curve' AND lp.lifecycle IN ('live','migration_ready')
      AND m.decimals IS NOT NULL AND q.decimals IS NOT NULL AND q.symbol IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM chain_read_v1.vaults v WHERE v.meme_type=lp.coin_type AND v.origin_kind='launch')${where}`;

/** Presales retain priority even when hidden, followed by the earliest eligible native launch vault. */
function homeCoinSources(extraSources: string): string {
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
    ${extraSources}
  ) c
  WHERE NOT EXISTS (SELECT 1 FROM chain_read_v1.presales p WHERE p.sale_token=c.sale_token)
  ORDER BY c.sale_token,c.tracked_pool_only,c.created_checkpoint,c.created_tx_slot,c.created_event_slot,c.vault_id))`;
}

/** Market detail and trade feeds require coverage from a launch or a presale. */
export const HOME_COIN_SOURCES = homeCoinSources("");
/**
 * Discover's whole list: presales, launch vault coins and tracked pools with
 * partial market coverage. Live curves stay out: there are about a thousand,
 * mostly dust, and the facts and window reads cost per coin (#71 timed out).
 */
export const HOME_DISCOVER_COIN_SOURCES = homeCoinSources(TRACKED_POOL_SOURCE);
/** Reads by id (saved coins, a page's coins) also find a live curve; the id filter reaches every branch. */
export const HOME_LIST_COIN_SOURCES = homeCoinSources(`UNION ALL ${liveCurves()}\n    ${TRACKED_POOL_SOURCE}`);

/**
 * Discover's Almost graduated list (`stage=almost`): live curves at the 60%
 * line or past it, and curves ready to migrate. The line is checked here, on
 * the view's reserve and target, so the per-coin reads see only these few;
 * `curveOf` then computes each percent through the SDK. Same columns as
 * `homeCoinSources`.
 */
export const HOME_ALMOST_CURVE_SOURCES = `(SELECT DISTINCT ON (c.sale_token) c.sale_token AS source_id,NULL::text AS presale_id,c.sale_token,c.sale_symbol,c.sale_name,c.sale_icon_url,
  c.sale_decimals,'migrated'::text AS lifecycle,c.venue,c.pool_id,c.quote_type,c.quote_symbol,c.quote_decimals,
  NULL::bigint AS start_ms,NULL::bigint AS end_ms,NULL::numeric AS raise_target,NULL::numeric AS total_commitments,NULL::bigint AS participants,
  c.tracked_pool_only
  FROM (${liveCurves(`
      AND (lp.lifecycle='migration_ready' OR lp.quote_reserve * 10000 >= ${HOME_ALMOST_GRADUATED_BPS} * lp.graduation_target)`)}) c
  WHERE NOT EXISTS (SELECT 1 FROM chain_read_v1.presales p WHERE p.sale_token=c.sale_token)
  ORDER BY c.sale_token,c.created_checkpoint,c.pool_id)`;
