import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

/**
 * The social worker's step interface (T-025). A step runs once per pass in
 * its own transaction on the watcher pool: it reads its cursor from
 * `social_worker_state`, reads chain data through `chain_read_v1` views no
 * further than `bounds` (the watermark of the pipeline that writes that
 * data), writes its rows as module `social`, and stores its new cursor, all
 * committed together. Sui checkpoints are final, so no step handles a
 * reorganization; a failed transaction leaves the cursor where it was and the
 * next pass repeats the work (writes are idempotent by key).
 */

/** blast-infra's pipelines (`chain_read_v1.watermark`): `market` writes trades and prices, `presale` presales, lifecycle and activity. */
export type SocialWorkerPipeline = "market" | "presale";

export type SocialWorkerBounds = Readonly<{
  pipeline: SocialWorkerPipeline;
  /** The last checkpoint the pipeline committed: a step reads nothing past it. */
  checkpoint: number;
  /** That checkpoint's timestamp: the chain clock time-based steps use. */
  timestampMs: number;
  /** Native cut identity, captured with projection coverage. */
  checkpointDigest?: string;
}>;

/** The counts a step reports; the pass metric sums them. */
export const SOCIAL_WORKER_COUNTS = [
  "intents_resolved",
  "intents_rejected",
  "intents_late",
  "claims_confirmed",
  "claims_failed",
  "claims_expired",
  "milestones_written",
  "notifications_written",
  "notifications_deleted",
  "snapshots_written",
  "snapshots_skipped",
] as const;
export type SocialWorkerCount = (typeof SOCIAL_WORKER_COUNTS)[number];
export type SocialWorkerStepReport = Readonly<Partial<Record<SocialWorkerCount, number>>>;

export type SocialWorkerStepContext = Readonly<{
  /** The process clock (simulated in tests), for steps that are not chain-bound. */
  now: () => number;
}>;

export type SocialWorkerStepCommit = (tx: ModuleTransaction<"social">) => Promise<SocialWorkerStepReport>;

/** Each callback gets one short repeatable-read snapshot; providers run after it returns. */
export type SocialWorkerReadSnapshot = <Value>(read: (db: ModuleTransaction<"social">) => Promise<Value>) => Promise<Value>;

/** What a step's `health` check reports; the worker sends it as the alert's details. */
export type SocialAlertDetails = Readonly<Record<string, string | number | boolean | null>>;

export type SocialWorkerStep = Readonly<{
  /** `^[a-z][a-z0-9-]*$`; also the default cursor name. */
  name: string;
  /** The pipeline whose watermark bounds the step; null for a step that reads no chain data (retention). */
  pipeline: SocialWorkerPipeline | null;
  /** Additional projections that must cover the same cut (portfolio uses both). */
  requiredPipelines?: readonly SocialWorkerPipeline[];
  run(tx: ModuleTransaction<"social">, bounds: SocialWorkerBounds | null, context: SocialWorkerStepContext): Promise<SocialWorkerStepReport>;
  /** Optional outside-transaction preparation; its commit must revalidate every dependency. */
  prepare?(readSnapshot: SocialWorkerReadSnapshot, bounds: SocialWorkerBounds | null, context: SocialWorkerStepContext): Promise<SocialWorkerStepCommit>;
  /**
   * For a step with a deadline of its own (the daily portfolio snapshot): what
   * the runtime's minute check reports as the `step_late:<name>` alert while
   * the step is behind it, or null when it is on time (the alert clears).
   */
  health?(db: ReadableDatabase, nowMs: number): Promise<SocialAlertDetails | null>;
}>;

/** A step's cursor (`social_worker_state.value`), locked for the rest of the transaction; null before its first pass. */
export async function readStepCursor<Value>(tx: ReadableDatabase, name: string): Promise<Value | null> {
  const { rows } = await tx.read<{ value: Value }>("SELECT value FROM social_worker_state WHERE name = $1 FOR UPDATE", [name]);
  return rows[0]?.value ?? null;
}

/** Stores a step's cursor in the step's transaction. */
export async function writeStepCursor(tx: ModuleTransaction<"social">, name: string, value: unknown): Promise<void> {
  await tx.write(
    "social_worker_state",
    `INSERT INTO social_worker_state (name, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, JSON.stringify(value)],
  );
}
