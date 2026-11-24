import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";

export const TEST_SUI_COIN_TYPES_SQL = TEST_SUI_COIN_TYPES.map((type) => `'${type}'`).join(", ");

/** Include the original quote before and after graduation, even without display metadata. */
export const TEST_SUI_LAUNCH_TYPES = `(
  SELECT sale_token AS coin_type FROM chain_read_v1.presales
  WHERE quote_type IN (${TEST_SUI_COIN_TYPES_SQL})
  UNION ALL
  SELECT coin_type FROM chain_read_v1.pools
  WHERE venue = 'blast_curve' AND quote_type IN (${TEST_SUI_COIN_TYPES_SQL})
)`;

/** Canonical Blast origins; a graduated coin keeps its original launch ID. */
export const BLAST_LAUNCH_COINS = `(SELECT p.presale_id AS asset_id, p.presale_id, NULL::text AS launch_id,
    p.sale_token AS coin_type, p.sale_name AS name, coalesce(p.sale_symbol, split_part(p.sale_token, '::', 3)) AS symbol,
    p.sale_icon_url AS icon_url, p.sale_decimals AS decimals, p.quote_type, p.pool_id
  FROM ${SHOWN_PRESALES} p
  UNION ALL
  SELECT curve.pool_id AS asset_id, NULL::text AS presale_id, curve.pool_id AS launch_id,
    c.coin_type, c.name, coalesce(c.symbol, split_part(c.coin_type, '::', 3)) AS symbol,
    c.icon_url, c.decimals, curve.quote_type, split_part(c.pool_key, ':', 2) AS pool_id
  FROM chain_read_v1.coins c
  JOIN chain_read_v1.pools curve ON curve.coin_type = c.coin_type AND curve.venue = 'blast_curve'
  WHERE c.decimals IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ${SHOWN_PRESALES} p WHERE p.sale_token = c.coin_type))`;
