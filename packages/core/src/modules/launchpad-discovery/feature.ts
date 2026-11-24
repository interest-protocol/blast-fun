import type { Pool } from "pg";
import { autocommitReader } from "../database/transaction.ts";

/** Read saved pins in display order, optionally restricting them to indexed curves. */
export async function readBondingFeatures(
  pool: Pool,
  onlyEligible = false,
): Promise<string[]> {
  const { rows } = await autocommitReader(pool, "launchpad-discovery").read<{
    launch_id: string;
  }>(
    `SELECT launch_id FROM mission_control_bonding_feature f
      WHERE NOT $1::boolean OR EXISTS (
        SELECT 1 FROM chain_read_v1.pools p WHERE p.pool_id = f.launch_id
        AND p.venue = 'blast_curve' AND p.lifecycle IN ('opening_round', 'live', 'migration_ready', 'migrated')
      )
      ORDER BY pinned_at DESC, launch_id COLLATE "C" DESC`,
    [onlyEligible],
  );
  return rows.map((row) => row.launch_id);
}
