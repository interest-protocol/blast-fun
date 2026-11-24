// The fee-claim job's rows (`mission_control_fee_claims`, one per network and
// Blast curve launch). `active` records are revisited every claim interval;
// writes never reopen a final state; every claim decision comes from a fresh
// chain read.

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import { transactionDatabase, workerDatabase } from "#workers/lib/database.ts";
import { feeClaims as records } from "#workers/lib/database/schema.ts";
import { withTransaction, type TransactionContext } from "@blast/core/modules/database/transaction.ts";

import type { CurveLaunch } from "../blast-keeper/launch-discovery.ts";

const MODULE = "fee-claims";
export const FEE_CLAIM_JOB = "fee-claims";
const active = eq(records.state, "active");

export type FeeClaimRecord = Readonly<{
  network: string;
  launchId: string;
  memeType: string;
  quoteType: string;
  partnerId: string | null;
  attempts: number;
  /** Why the last visit retried, or null. */
  errorClass: string | null;
  detectedAt: Date;
}>;

/** Records discovered launches as `active`, due now; one already recorded is kept as it is. */
export async function recordLaunches(transaction: TransactionContext, network: string, launches: readonly CurveLaunch[]): Promise<void> {
  await transactionDatabase(transaction.forModule(MODULE)).insert(records).values(launches.map((launch) => ({
    network,
    launchId: launch.launchId,
    memeType: launch.memeType,
    quoteType: launch.quoteType,
    createdCheckpoint: launch.createdCheckpoint,
    state: "active" as const,
    nextEligibleAt: sql`now()`,
    detectedAt: sql`now()`,
    updatedAt: sql`now()`,
  }))).onConflictDoNothing({ target: [records.network, records.launchId] });
}

/** Active records whose time has come, oldest first. */
export async function dueRecords(pool: Pool, network: string, limit: number): Promise<FeeClaimRecord[]> {
  return workerDatabase(pool, MODULE).select({
    network: records.network,
    launchId: records.launchId,
    memeType: records.memeType,
    quoteType: records.quoteType,
    partnerId: records.partnerId,
    attempts: records.attempts,
    errorClass: records.errorClass,
    detectedAt: records.detectedAt,
  }).from(records).where(and(eq(records.network, network), active, lte(records.nextEligibleAt, sql`now()`)))
    .orderBy(asc(records.nextEligibleAt), asc(records.launchId)).limit(limit);
}

async function update(pool: Pool, record: FeeClaimRecord, changes: PgUpdateSetSource<typeof records>): Promise<boolean> {
  const rows = await workerDatabase(pool, MODULE).update(records).set({ ...changes, updatedAt: sql`now()` }).where(and(
    eq(records.network, record.network), eq(records.launchId, record.launchId), active,
  )).returning({ key: records.launchId });
  return rows.length === 1;
}

const after = (delayMs: number) => sql`now() + ${delayMs} * INTERVAL '1 millisecond'`;

/** The launch's partner as last read from chain. */
export function recordIdentity(pool: Pool, record: FeeClaimRecord, partnerId: string | null): Promise<boolean> {
  return update(pool, record, { partnerId });
}

class PartialBatch extends Error {}

/**
 * The digest of a transaction carrying claims of `batch` (one network's
 * launches) is written on every launch before its bytes are sent: all of them
 * or none. False, writing nothing, when any is no longer active.
 */
export async function recordClaimSubmissions(pool: Pool, batch: readonly FeeClaimRecord[], digest: string): Promise<boolean> {
  const network = batch[0]!.network;
  const ids = [...new Set(batch.map((record) => record.launchId))];
  try {
    return await withTransaction(pool, async (transaction) => {
      const rows = await transactionDatabase(transaction.forModule(MODULE)).update(records)
        .set({ latestDigest: digest, updatedAt: sql`now()` })
        .where(and(eq(records.network, network), inArray(records.launchId, ids), active))
        .returning({ key: records.launchId });
      if (rows.length !== ids.length) throw new PartialBatch();
      return true;
    }, { label: "fee-claims.record_submissions" });
  } catch (error) {
    if (error instanceof PartialBatch) return false;
    throw error;
  }
}

/** One claim executed. */
export function recordClaimed(pool: Pool, record: FeeClaimRecord): Promise<boolean> {
  return update(pool, record, {
    curveClaims: sql`${records.curveClaims} + 1`,
    lastClaimedAt: sql`now()`,
  });
}

/** The visit is done: nothing failed; due again after `intervalMs`. */
export function recordVisited(pool: Pool, record: FeeClaimRecord, intervalMs: number): Promise<boolean> {
  return update(pool, record, { attempts: 0, errorClass: null, nextEligibleAt: after(intervalMs) });
}

/** Back off: revisited after `delayMs`; `failed` counts a failed claim (it only grows the backoff). */
export function recordRetry(pool: Pool, record: FeeClaimRecord, errorClass: string, delayMs: number, failed = false): Promise<boolean> {
  return update(pool, record, { errorClass, nextEligibleAt: after(delayMs), attempts: sql`${records.attempts} + ${failed ? 1 : 0}` });
}

/** Final: nothing will accrue to claim again (`complete`), or the worker never signs for it again. */
export function recordClosed(pool: Pool, record: FeeClaimRecord, state: "complete" | "rejected" | "stalled", errorClass: string | null = null): Promise<boolean> {
  return update(pool, record, { state, errorClass, closedAt: sql`now()` });
}

export type FeeClaimBacklog = Readonly<{ active: number; due: number; retrying: number; stalled: number }>;

export async function readBacklog(pool: Pool, network: string): Promise<FeeClaimBacklog> {
  const rows = await workerDatabase(pool, MODULE).select({
    active: sql`count(*) FILTER (WHERE ${records.state} = 'active')`.mapWith(Number),
    due: sql`count(*) FILTER (WHERE ${records.state} = 'active' AND ${records.nextEligibleAt} <= now())`.mapWith(Number),
    retrying: sql`count(*) FILTER (WHERE ${records.state} = 'active' AND ${records.errorClass} IS NOT NULL)`.mapWith(Number),
    stalled: sql`count(*) FILTER (WHERE ${records.state} = 'stalled')`.mapWith(Number),
  }).from(records).where(eq(records.network, network));
  const row = rows[0];
  return { active: row?.active ?? 0, due: row?.due ?? 0, retrying: row?.retrying ?? 0, stalled: row?.stalled ?? 0 };
}
