import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
// The migration job's rows (`mission_control_launch_migrations`, one per
// network and launch). Candidates come only from blast-infra's committed
// `chain_read_v1` views on the primary: Blast curve pools whose lifecycle is
// `migration_ready`, read in the same statement as the watermark that names
// this deployment, so a record's `ready_checkpoint` is the committed
// watermark checkpoint at which the job first saw it ready (not the lifecycle
// change's own checkpoint, which the view lacks). Record writes never reopen
// a final state.

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import { transactionDatabase, workerDatabase } from "#workers/lib/database.ts";
import { migrations as records } from "#workers/lib/database/schema.ts";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { autocommitWrite, withTransaction } from "@blast/core/modules/database/transaction.ts";

const MODULE = "launch-migration";
const TABLE = "mission_control_launch_migrations";
const unfinished = inArray(records.state, ["pending", "submitted", "blocked"]);
export const MIGRATION_JOB = "launch-migration";

export type MigrationState = "pending" | "submitted" | "blocked" | "migrated" | "rejected" | "stalled";
export type MigrationVenue = MigratorVenue;
export type MigrationOutcome = "migrated-by-worker" | "already-migrated";

export type MigrationRecord = Readonly<{
  network: string;
  launchId: string;
  memeType: string;
  quoteType: string;
  state: MigrationState;
  attempts: number;
  /** Every digest recorded before sending, oldest first. */
  digests: readonly string[];
  /** Why the last visit ended without migration, or null. */
  errorClass: string | null;
  detectedAt: Date;
}>;

const DISCOVER = `INSERT INTO mission_control_launch_migrations
    (network, launch_id, meme_type, quote_type, ready_checkpoint, state, next_eligible_at, detected_at, updated_at)
  SELECT $1, p.pool_id, p.coin_type, p.quote_type, w.checkpoint, 'pending', now(), now(), now()
  FROM chain_read_v1.pools p, chain_read_v1.watermark w
  WHERE w.network = $1 AND w.deployment_fingerprint = $2 AND w.checkpoint IS NOT NULL
    AND p.venue = 'blast_curve' AND p.lifecycle = 'migration_ready'
    AND p.created_checkpoint <= w.checkpoint
    AND p.pool_id ~ '^0x[0-9a-f]{64}$'
    AND NOT EXISTS (
      SELECT 1 FROM mission_control_launch_migrations m WHERE m.network = $1 AND m.launch_id = p.pool_id
    )
  ORDER BY p.created_checkpoint, p.pool_key
  LIMIT $3
  ON CONFLICT (network, launch_id) DO NOTHING`;
assertChainReadThroughViews(DISCOVER);

/**
 * Records up to `limit` committed MigrationReady launches that have no record
 * yet, oldest first, and returns how many. A launch already recorded (in any
 * state) is never recorded again, so every page makes progress and a restart
 * neither skips nor duplicates one.
 */
export async function discoverReady(
  pool: Pool,
  { network, fingerprint, limit }: Readonly<{ network: string; fingerprint: string; limit: number }>,
): Promise<number> {
  const { rowCount } = await autocommitWrite(pool, MODULE, TABLE, DISCOVER, [network, fingerprint, limit]);
  return rowCount ?? 0;
}

/** Unfinished records whose backoff has passed, oldest first. */
export async function dueRecords(pool: Pool, network: string, limit: number): Promise<MigrationRecord[]> {
  return workerDatabase(pool, MODULE).select({
    network: records.network,
    launchId: records.launchId,
    memeType: records.memeType,
    quoteType: records.quoteType,
    state: records.state,
    attempts: records.attempts,
    digests: records.digests,
    errorClass: records.errorClass,
    detectedAt: records.detectedAt,
  }).from(records).where(and(eq(records.network, network), unfinished, lte(records.nextEligibleAt, sql`now()`)))
    .orderBy(records.nextEligibleAt, records.launchId).limit(limit);
}

/** Updates an unfinished record; false when it is already final (another worker closed it). */
async function updateUnfinished(pool: Pool, record: MigrationRecord, changes: PgUpdateSetSource<typeof records>): Promise<boolean> {
  const rows = await workerDatabase(pool, MODULE).update(records).set({ ...changes, updatedAt: sql`now()` }).where(and(
    eq(records.network, record.network), eq(records.launchId, record.launchId), unfinished,
  )).returning({ key: records.launchId });
  return rows.length === 1;
}

/** The launch's recorded venue, as the chain shows it. */
export function recordVenue(pool: Pool, record: MigrationRecord, venue: MigrationVenue): Promise<boolean> {
  return updateUnfinished(pool, record, { venue });
}

class PartialBatch extends Error {}

/**
 * The digest of a transaction carrying `batch` (one network's records) is
 * written on every record, and counted as an attempt of each, before the
 * bytes are submitted: all of them or none. False, writing nothing, when any
 * is already final.
 */
export async function recordSubmissions(pool: Pool, batch: readonly MigrationRecord[], digest: string): Promise<boolean> {
  const network = batch[0]!.network;
  const ids = batch.map((record) => record.launchId);
  try {
    return await withTransaction(pool, async (transaction) => {
      const rows = await transactionDatabase(transaction.forModule(MODULE)).update(records).set({
        state: "submitted", latestDigest: digest, attempts: sql`${records.attempts} + 1`, errorClass: null,
        digests: sql`array_append(${records.digests}, ${digest}::text)`, updatedAt: sql`now()`,
      }).where(and(eq(records.network, network), inArray(records.launchId, ids), unfinished))
        .returning({ key: records.launchId });
      if (rows.length !== new Set(ids).size) throw new PartialBatch();
      return true;
    }, { label: "launch-migration.record_submissions" });
  } catch (error) {
    if (error instanceof PartialBatch) return false;
    throw error;
  }
}

export function recordMigrated(pool: Pool, record: MigrationRecord, outcome: MigrationOutcome): Promise<boolean> {
  return updateUnfinished(pool, record, { state: "migrated", outcome, migratedAt: sql`now()`, errorClass: null });
}

/** A final refusal: the worker never signs for this record again. */
export function recordFinal(pool: Pool, record: MigrationRecord, state: "rejected" | "stalled", errorClass: string): Promise<boolean> {
  return updateUnfinished(pool, record, { state, errorClass });
}

/**
 * A configuration block: the worker signs nothing for this launch while it
 * holds, and reads it again after `delayMs` (a manual migration still closes
 * it as success; a fixed configuration resumes it; one of our own digests
 * that lands later closes it as ours). The record is `blocked` whatever it
 * was before, so the backlog counts every block.
 */
export function recordBlocked(pool: Pool, record: MigrationRecord, errorClass: string, delayMs: number): Promise<boolean> {
  return updateUnfinished(pool, record, {
    state: "blocked", errorClass, nextEligibleAt: sql`now() + ${delayMs} * INTERVAL '1 millisecond'`,
  });
}

/**
 * Back off: the record is revisited after `delayMs`. A blocked record whose
 * block cleared is pending again. `attempts` changes the count: 1 for a
 * failed simulation or a local failure, -1 to refund the attempt its digest
 * counted when another record of its batch failed the transaction.
 */
export function recordRetry(
  pool: Pool,
  record: MigrationRecord,
  errorClass: string,
  delayMs: number,
  attempts: -1 | 0 | 1 = 0,
): Promise<boolean> {
  return updateUnfinished(pool, record, {
    state: sql`CASE WHEN ${records.state} = 'blocked' THEN 'pending' ELSE ${records.state} END`,
    errorClass, nextEligibleAt: sql`now() + ${delayMs} * INTERVAL '1 millisecond'`,
    attempts: sql`greatest(${records.attempts} + ${attempts}, 0)`,
  });
}

/**
 * Unfinished records by state. `oldestMs` is the age of the oldest `pending`
 * or `submitted` record: work the job can still do. A block waits on
 * configuration or an operator (it is counted in `blocked`), so it never
 * holds the backlog age up.
 */
export type Backlog = Readonly<{ pending: number; submitted: number; blocked: number; stalled: number; oldestMs: number }>;

export async function readBacklog(pool: Pool, network: string): Promise<Backlog> {
  const rows = await workerDatabase(pool, MODULE).select({
    pending: sql`count(*) FILTER (WHERE ${records.state} = 'pending')`.mapWith(Number),
    submitted: sql`count(*) FILTER (WHERE ${records.state} = 'submitted')`.mapWith(Number),
    blocked: sql`count(*) FILTER (WHERE ${records.state} = 'blocked')`.mapWith(Number),
    stalled: sql`count(*) FILTER (WHERE ${records.state} = 'stalled')`.mapWith(Number),
    oldestMs: sql`(extract(epoch FROM now() - min(${records.detectedAt}) FILTER (WHERE ${records.state} IN ('pending', 'submitted'))) * 1000)::bigint`.mapWith(Number),
  }).from(records).where(eq(records.network, network));
  const row = rows[0];
  return { pending: row?.pending ?? 0, submitted: row?.submitted ?? 0, blocked: row?.blocked ?? 0, stalled: row?.stalled ?? 0, oldestMs: row?.oldestMs ?? 0 };
}
