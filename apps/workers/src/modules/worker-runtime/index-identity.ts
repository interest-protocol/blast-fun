// Which network, deployment and committed checkpoint blast-infra's index
// serves. A keeper job reads it before it discovers or signs anything: an
// index of another network or deployment blocks the job.

import type { Pool } from "pg";

import { workerDatabase } from "#workers/lib/database.ts";
import { chainWatermark } from "#workers/lib/database/schema.ts";

const MODULE = "worker-runtime";

type IndexIdentity = Readonly<{ network: string; deploymentFingerprint: string; checkpoint: string | null }>;

/** The index's identity; null before blast-infra starts. */
async function readIndexIdentity(pool: Pool): Promise<IndexIdentity | null> {
  const rows = await workerDatabase(pool, MODULE).select().from(chainWatermark);
  const row = rows[0];
  return row
    ? { network: row.network, deploymentFingerprint: row.deploymentFingerprint, checkpoint: row.checkpoint?.toString() ?? null }
    : null;
}

/** The reasons the index blocks this deployment's job, or its committed checkpoint (null before its first). */
type IndexGate =
  | Readonly<{ blocked: readonly string[] }>
  | Readonly<{ blocked: null; checkpoint: string | null }>;

export async function checkIndex(pool: Pool, network: string, fingerprint: string): Promise<IndexGate> {
  const index = await readIndexIdentity(pool);
  if (!index) return { blocked: ["index-unavailable"] };
  if (index.network !== network) return { blocked: ["wrong-network"] };
  if (index.deploymentFingerprint !== fingerprint) return { blocked: ["deployment-mismatch"] };
  return { blocked: null, checkpoint: index.checkpoint };
}
