import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import type { Cut } from "./plan.ts";

export class MissingRewardHistory extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`Reward history is unavailable: ${reason}.`); this.reason = reason; }
}

/** Complete native cuts, never the mutable head balances in `vaults`. */
export async function requireRewardCut(tx: TransactionContext, fingerprint: string, cut: Cut): Promise<void> {
  await tx.read("SELECT chain_read_v1.require_cut('mainnet',$1,$2,$3,ARRAY['market','intake'])", [fingerprint, cut.checkpoint, cut.digest]);
}

/** The current indexed cut of a deployment: the earliest checkpoint both pipelines completed without a fault. */
export async function completeCut(tx: TransactionContext, fingerprint: string): Promise<Cut> {
  const { rows } = await tx.read<{ checkpoint: string; digest: string; timestamp_ms: string }>(
    `SELECT h.checkpoint::text,h.digest,h.timestamp_ms::text FROM chain_read_v1.checkpoint_headers h
     WHERE h.checkpoint=(SELECT min(checkpoint) FROM chain_read_v1.projection_coverage
       WHERE network='mainnet' AND deployment_fingerprint=$1 AND pipeline IN ('market','intake') AND fault_checkpoint IS NULL)`, [fingerprint]);
  const row = rows[0];
  if (!row) throw new MissingRewardHistory("complete-cut");
  const cut = { checkpoint: row.checkpoint, digest: row.digest, timestampMs: row.timestamp_ms };
  await requireRewardCut(tx, fingerprint, cut);
  return cut;
}
