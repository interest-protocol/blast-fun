// The registration job's rows. Candidates come from blast-infra's
// `chain_read_v1` views only (`coins` without a pool, at or below the
// committed `watermark` checkpoint), paged in (created_checkpoint, coin_type)
// order behind a durable cursor that advances in the same transaction as the
// records it found. Record writes never reopen a final state.

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import { workerDatabase, transactionDatabase } from "#workers/lib/database.ts";
import { registrations as records, workerJobs } from "#workers/lib/database/schema.ts";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";

const MODULE = "coin-registration";
const unfinished = inArray(records.state, ["pending", "submitted"]);
export const REGISTRATION_JOB = "coin-registration";

export type RegistrationState = "pending" | "submitted" | "registered" | "rejected" | "stalled";

export type RegistrationRecord = Readonly<{
  network: string;
  memeType: string;
  state: RegistrationState;
  attempts: number;
  latestDigest: string | null;
  errorClass: string | null;
  detectedAt: Date;
}>;

const CANDIDATES = `SELECT coin_type, created_checkpoint::text AS created_checkpoint
  FROM chain_read_v1.coins
  WHERE pool_key IS NULL
    AND created_checkpoint <= $1::bigint
    AND (created_checkpoint, coin_type) > ($2::bigint, $3::text)
  ORDER BY created_checkpoint, coin_type
  LIMIT $4`;
assertChainReadThroughViews(CANDIDATES);

type Cursor = Readonly<{ checkpoint: string; coinType: string }>;

/**
 * Records the next page of candidates after the cursor, up to `checkpoint`,
 * and advances the cursor past them, in one transaction. Returns how many
 * candidates the page held (records already present are kept as they are).
 */
export async function discoverCandidates(
  pool: Pool,
  { network, checkpoint, limit }: Readonly<{ network: string; checkpoint: string; limit: number }>,
): Promise<number> {
  return withTransaction(pool, async (transaction) => {
    const jobs = transactionDatabase(transaction.forModule("worker-runtime"));
    const state = await jobs.select({ cursor: sql<Cursor | null>`${workerJobs.cursor}` }).from(workerJobs)
      .where(and(eq(workerJobs.job, REGISTRATION_JOB), eq(workerJobs.network, network)));
    const cursor = state[0]?.cursor ?? { checkpoint: "-1", coinType: "" };
    const { rows } = await transaction.read<{ coin_type: string; created_checkpoint: string }>(CANDIDATES, [
      checkpoint,
      cursor.checkpoint,
      cursor.coinType,
      limit,
    ]);
    const last = rows.at(-1);
    if (!last) return 0;
    await transactionDatabase(transaction.forModule(MODULE)).insert(records).values(rows.map((row) => ({
      network, memeType: row.coin_type, createdCheckpoint: BigInt(row.created_checkpoint), state: "pending" as const,
      nextEligibleAt: sql`now()`, detectedAt: sql`now()`, updatedAt: sql`now()`,
    }))).onConflictDoNothing({ target: [records.network, records.memeType] });
    const nextCursor = { checkpoint: last.created_checkpoint, coinType: last.coin_type };
    await jobs.insert(workerJobs).values({ job: REGISTRATION_JOB, network, cursor: nextCursor, updatedAt: sql`now()` })
      .onConflictDoUpdate({ target: [workerJobs.job, workerJobs.network], set: { cursor: nextCursor, updatedAt: sql`now()` } });
    return rows.length;
  }, { label: "registration.discover" });
}

/** Unfinished records whose backoff has passed, oldest first. */
export async function dueRecords(pool: Pool, network: string, limit: number): Promise<RegistrationRecord[]> {
  return workerDatabase(pool, MODULE).select({
    network: records.network,
    memeType: records.memeType,
    state: records.state,
    attempts: records.attempts,
    latestDigest: records.latestDigest,
    errorClass: records.errorClass,
    detectedAt: records.detectedAt,
  }).from(records).where(and(eq(records.network, network), unfinished, lte(records.nextEligibleAt, sql`now()`)))
    .orderBy(records.nextEligibleAt, records.memeType).limit(limit);
}

/** Updates an unfinished record; false when it is already final (another worker closed it). */
async function updateUnfinished(pool: Pool, record: RegistrationRecord, changes: PgUpdateSetSource<typeof records>): Promise<boolean> {
  const rows = await workerDatabase(pool, MODULE).update(records).set({ ...changes, updatedAt: sql`now()` }).where(and(
    eq(records.network, record.network), eq(records.memeType, record.memeType), unfinished,
  )).returning({ key: records.memeType });
  return rows.length === 1;
}

export type PublicationFacts = Readonly<{
  currency: Readonly<{ objectId: string; version: string; digest: string }>;
  publicationDigest: string | null;
  ticketId: string | null;
}>;

export function recordPublication(pool: Pool, record: RegistrationRecord, facts: PublicationFacts): Promise<boolean> {
  return updateUnfinished(pool, record, {
    pendingCurrencyId: facts.currency.objectId, pendingCurrencyVersion: facts.currency.version, pendingCurrencyDigest: facts.currency.digest,
    publicationDigest: sql`COALESCE(${facts.publicationDigest}, ${records.publicationDigest})`,
    ticketId: sql`COALESCE(${facts.ticketId}, ${records.ticketId})`,
  });
}

class PartialBatch extends Error {}

/**
 * The digest of a transaction carrying `batch` (one network's records) is
 * written on every record, each counted as an attempt, in one database
 * transaction before the bytes are submitted. False, writing nothing, when any
 * record is already final (another worker closed it).
 */
export async function recordSubmissions(pool: Pool, batch: readonly RegistrationRecord[], digest: string): Promise<boolean> {
  const network = batch[0]!.network;
  const memeTypes = batch.map((record) => record.memeType);
  try {
    return await withTransaction(pool, async (transaction) => {
      const rows = await transactionDatabase(transaction.forModule(MODULE)).update(records).set({
        state: "submitted", latestDigest: digest, attempts: sql`${records.attempts} + 1`, errorClass: null, updatedAt: sql`now()`,
      }).where(and(eq(records.network, network), inArray(records.memeType, memeTypes), unfinished))
        .returning({ key: records.memeType });
      if (rows.length !== new Set(memeTypes).size) throw new PartialBatch();
      return true;
    }, { label: "registration.record_submissions" });
  } catch (error) {
    if (error instanceof PartialBatch) return false;
    throw error;
  }
}

export function recordRegistered(
  pool: Pool,
  record: RegistrationRecord,
  outcome: "registered-by-worker" | "already-registered",
  sharedCurrencyId: string,
): Promise<boolean> {
  return updateUnfinished(pool, record, {
    state: "registered", outcome, sharedCurrencyId, registeredAt: sql`now()`, errorClass: null,
  });
}

/** A final refusal: the worker never signs for this record. */
export function recordRejected(pool: Pool, record: RegistrationRecord, state: "rejected" | "stalled", errorClass: string): Promise<boolean> {
  return updateUnfinished(pool, record, { state, errorClass });
}

/**
 * Back off: the record is revisited after `delayMs`, keeping its state.
 * `attempts` 1 counts a failed simulation or a local failure; -1 refunds the
 * attempt of a batch another record failed.
 */
export function recordRetry(
  pool: Pool,
  record: RegistrationRecord,
  errorClass: string,
  delayMs: number,
  attempts: -1 | 0 | 1 = 0,
): Promise<boolean> {
  return updateUnfinished(pool, record, {
    errorClass, nextEligibleAt: sql`now() + ${delayMs} * INTERVAL '1 millisecond'`,
    attempts: sql`greatest(${records.attempts} + ${attempts}, 0)`,
  });
}

export type Backlog = Readonly<{ pending: number; submitted: number; stalled: number; oldestMs: number }>;

export async function readBacklog(pool: Pool, network: string): Promise<Backlog> {
  const rows = await workerDatabase(pool, MODULE).select({
    pending: sql`count(*) FILTER (WHERE ${records.state} = 'pending')`.mapWith(Number),
    submitted: sql`count(*) FILTER (WHERE ${records.state} = 'submitted')`.mapWith(Number),
    stalled: sql`count(*) FILTER (WHERE ${records.state} = 'stalled')`.mapWith(Number),
    oldestMs: sql`(extract(epoch FROM now() - min(${records.detectedAt}) FILTER (WHERE ${records.state} IN ('pending', 'submitted'))) * 1000)::bigint`.mapWith(Number),
  }).from(records).where(eq(records.network, network));
  const row = rows[0];
  return { pending: row?.pending ?? 0, submitted: row?.submitted ?? 0, stalled: row?.stalled ?? 0, oldestMs: row?.oldestMs ?? 0 };
}
