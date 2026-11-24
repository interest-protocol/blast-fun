import type { Pool } from "pg";
import type { Snapshot, SnapshotV3 } from "./contract.ts";

export async function readSnapshot(pool: Pool): Promise<Snapshot | null> {
  if (pool.waitingCount >= 10) {
    throw new Error("Snapshot reader busy");
  }
  const result = await pool.query<Snapshot>(
    "SELECT generated_at, payload FROM blast_analytics.snapshots WHERE singleton",
  );
  return result.rows[0] ?? null;
}

export async function readSnapshotV3(pool: Pool): Promise<SnapshotV3 | null> {
  if (pool.waitingCount >= 10) {
    throw new Error("Snapshot reader busy");
  }
  const result = await pool.query<SnapshotV3>(
    "SELECT generated_at, payload FROM blast_analytics.snapshots_v3 WHERE singleton",
  );
  return result.rows[0] ?? null;
}
