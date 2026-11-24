import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

/**
 * R3-23: Blast checked who is behind a coin. A sale's flag is
 * `social_sale_trust` (0088) by presale id; a bonding-curve coin's is
 * `social_coin_trust` (0164) by coin type. Each side is one primary-key probe.
 * Pass the SQL expressions the read already has; a NULL never matches.
 */
export function verifiedTeamSql(presaleId: string, coinType: string): string {
  return `(EXISTS (SELECT 1 FROM social_sale_trust vt WHERE vt.presale_id = ${presaleId} AND vt.verified_team)
    OR EXISTS (SELECT 1 FROM social_coin_trust vc WHERE vc.coin_type = ${coinType}))`;
}

/** The curve coin page's flag: the launch's coin has a `social_coin_trust` row. Two key probes (the curve's pool key, then the coin type) per page read. */
export async function readLaunchVerifiedTeam(launchId: string, database?: ReadableDatabase): Promise<boolean> {
  const db = database ?? autocommitReader(primaryPool(), "social", { label: "social.launch_verified_team" });
  const { rows } = await db.read<{ verified: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM chain_read_v1.pools p JOIN social_coin_trust vc ON vc.coin_type = p.coin_type
      WHERE p.pool_key = 'blast_curve:' || $1 AND p.venue = 'blast_curve') AS verified`,
    [launchId],
  );
  return rows[0]?.verified === true;
}
