import { z } from "zod";

import { normalizeSuiAddress } from "@mysten/sui/utils";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { vestingClaimedEvents } from "@blast/core/modules/sponsor/linear-vesting.ts";
import { settleLoggedTransaction, type TransactionSettlement } from "@blast/core/modules/social/transactions/log.ts";
import { readStepCursor, writeStepCursor, type SocialWorkerBounds, type SocialWorkerStep, type SocialWorkerStepReport } from "../worker/steps.ts";
import { vestingScheduleFromClaimKey } from "@blast/core/modules/social/claims/identity.ts";

/** Digest-specific shared native evidence; no aggregate schedule balance proves an individual attempt. */
export type VestingClaimExecution = Readonly<{
  digest: string;
  checkpoint: string | null;
  timestampMs: number | null;
  sender: string;
  success: boolean;
  events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[];
}>;

/** One bounded page of native digest evidence inside the leased output transaction. */
export const CLAIM_VESTING_EVIDENCE_BATCH = 16;
const STEP = "claim-vesting-settle";

type Cursor = Readonly<{ created_at_ms: string; tx_id: string }>;
type VestingRow = Cursor & Readonly<{
  account_id: string;
  idempotency_key: string;
  digest: string;
  presale_id: string;
  coin_type: string | null;
  schedule_presale_id: string | null;
  beneficiary: string | null;
  beneficiary_own: boolean;
}>;

/** Keyset pages of bound attempts. Unavailable digests cannot starve later attempts. */
export const VESTING_CLAIM_PAGE_SQL = `SELECT t.tx_id::text, t.created_at_ms::text, t.account_id::text, t.idempotency_key,
    t.digest, t.presale_id, t.coin_type, v.presale_id AS schedule_presale_id, v.beneficiary,
    EXISTS (SELECT 1 FROM social_wallet_owners o WHERE o.address = v.beneficiary AND o.account_id = t.account_id) AS beneficiary_own
  FROM social_transactions t
  LEFT JOIN chain_read_v1.vesting_schedules v ON v.schedule_id = right(t.idempotency_key, 66)
  WHERE t.state = 'submitted' AND t.kind IN ('claim_refund', 'claim_tokens', 'claim_vesting')
    AND t.kind = 'claim_vesting' AND t.digest IS NOT NULL
    AND t.idempotency_key ~ '^claim_vesting:[0-9a-f-]{36}:0x[0-9a-f]{64}$'
    AND ($1::bigint IS NULL OR (t.created_at_ms, t.tx_id) > ($1::bigint, $2::uuid))
  ORDER BY t.created_at_ms, t.tx_id
  LIMIT $3`;
assertChainReadThroughViews(VESTING_CLAIM_PAGE_SQL);

/** Native transaction/event evidence, bounded by the same coherent cut as the output transaction. */
export const VESTING_SHARED_EVIDENCE_SQL = `SELECT digest, checkpoint::text, timestamp_ms::text, sender, success, events
  FROM chain_read_v1.transaction_evidence
  WHERE digest = ANY($1::text[]) AND checkpoint <= $2::bigint AND timestamp_ms <= $3::bigint`;
assertChainReadThroughViews(VESTING_SHARED_EVIDENCE_SQL);

type SharedExecutionRow = Readonly<{
  digest: string; checkpoint: string; timestamp_ms: string; sender: string; success: boolean;
  events: unknown;
}>;

/** Malformed/partial evidence is unavailable, never inferred successful. */
const sharedVestingExecutionSchema = z.object({
  digest: z.string(),
  checkpoint: z.string().regex(/^[0-9]{1,20}$/),
  timestamp_ms: z.string().regex(/^[0-9]{1,20}$/).refine((value) => Number.isSafeInteger(Number(value))),
  sender: z.string().refine((value) => {
    try { return normalizeSuiAddress(value) === value; } catch { return false; }
  }),
  success: z.boolean(),
  events: z.array(z.object({
    eventType: z.string(),
    // PostgreSQL encode(bytea, 'base64') wraps at 76 columns with LF.
    bcs: z.string().transform((value) => value.replaceAll("\n", ""))
      .refine((value) => Buffer.from(value, "base64").toString("base64") === value)
      .transform((value) => Buffer.from(value, "base64")),
  })),
});

export function sharedVestingExecution(row: SharedExecutionRow): VestingClaimExecution | null {
  const parsed = sharedVestingExecutionSchema.safeParse(row);
  if (!parsed.success) return null;
  const data = parsed.data;
  return { digest: data.digest, checkpoint: data.checkpoint, timestampMs: Number(data.timestamp_ms), sender: data.sender, success: data.success, events: data.events };
}

async function readSharedExecutions(tx: ModuleTransaction<"social">, rows: readonly VestingRow[], bounds: SocialWorkerBounds): Promise<Map<string, VestingClaimExecution>> {
  if (rows.length === 0) return new Map();
  const answer = await tx.read<SharedExecutionRow>(VESTING_SHARED_EVIDENCE_SQL, [rows.map((row) => row.digest), bounds.checkpoint, bounds.timestampMs]);
  const executions = new Map<string, VestingClaimExecution>();
  for (const row of answer.rows) {
    const execution = sharedVestingExecution(row);
    if (execution !== null) executions.set(execution.digest, execution);
  }
  return executions;
}

/** Unknown inclusion/time waits; even a known execution cannot move ahead of the indexer. */
function reached(execution: VestingClaimExecution, digest: string, bounds: SocialWorkerBounds): execution is VestingClaimExecution & { timestampMs: number } {
  if (execution.digest !== digest || execution.checkpoint === null || !/^[0-9]{1,20}$/.test(execution.checkpoint)) return false;
  const checkpoint = Number(execution.checkpoint);
  const timestamp = execution.timestampMs;
  return Number.isSafeInteger(checkpoint) && checkpoint <= bounds.checkpoint
    && timestamp !== null && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= bounds.timestampMs;
}

/** A known schedule relates the pinned event to the logged sale, coin and account. Its totals are never read. */
function verdict(row: VestingRow, execution: VestingClaimExecution, bounds: SocialWorkerBounds): TransactionSettlement | null {
  const scheduleId = vestingScheduleFromClaimKey(row.idempotency_key, row.tx_id);
  if (scheduleId === null || row.beneficiary === null || row.schedule_presale_id === null || !reached(execution, row.digest, bounds)) return null;
  const settledAtMs = execution.timestampMs;
  if (!row.beneficiary_own || row.schedule_presale_id !== row.presale_id || normalizeSuiAddress(execution.sender) !== row.beneficiary) {
    return { state: "failed", failureCode: "mismatch", settledAtMs };
  }
  if (!execution.success) return { state: "failed", failureCode: "execution_failed", settledAtMs };
  const paid = vestingClaimedEvents(execution.events).some((event) => event.vestingId === scheduleId
    && event.beneficiary === row.beneficiary && event.coinType === row.coin_type);
  return paid
    ? { state: "confirmed", digest: row.digest, settledAtMs }
    : { state: "failed", failureCode: "mismatch", settledAtMs };
}

async function recover(
  tx: ModuleTransaction<"social">,
  bounds: SocialWorkerBounds,
  config: Readonly<{ batchSize: number }>,
): Promise<SocialWorkerStepReport> {
  const cursor = await readStepCursor<Cursor>(tx, STEP);
  const limit = Math.min(config.batchSize, CLAIM_VESTING_EVIDENCE_BATCH);
  const { rows } = await tx.read<VestingRow>(VESTING_CLAIM_PAGE_SQL, [cursor?.created_at_ms ?? null, cursor?.tx_id ?? null, limit]);
  const executions = await readSharedExecutions(tx, rows, bounds);
  let confirmed = 0;
  let failed = 0;
  for (const row of rows) {
    const execution = executions.get(row.digest);
    if (!execution) continue;
    const settlement = verdict(row, execution, bounds);
    if (settlement === null) continue;
    const outcome = await settleLoggedTransaction(tx, { accountId: row.account_id, idempotencyKey: row.idempotency_key }, settlement);
    if (outcome !== "settled") continue;
    if (settlement.state === "confirmed") confirmed += 1;
    else failed += 1;
  }
  const last = rows.at(-1);
  await writeStepCursor(tx, STEP, last ? { created_at_ms: last.created_at_ms, tx_id: last.tx_id } : null);
  return { claims_confirmed: confirmed, claims_failed: failed };
}

/** No role changes: the allowed schedule view supplies membership, shared native evidence supplies exact digest/event facts. */
export function vestingClaimStep(config: Readonly<{ batchSize: number }>): SocialWorkerStep {
  return { name: STEP, pipeline: "presale", run: (tx, bounds) => recover(tx, bounds!, config) };
}
