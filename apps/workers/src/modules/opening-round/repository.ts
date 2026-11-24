// The opening-round keeper's rows (`mission_control_opening_rounds`, one per
// network and Blast curve launch). Record writes never reopen a final state;
// every outcome comes from a fresh chain read.

import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import { transactionDatabase, workerDatabase } from "#workers/lib/database.ts";
import { openingRounds as records } from "#workers/lib/database/schema.ts";
import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";

import type { CurveLaunch } from "../blast-keeper/launch-discovery.ts";

const MODULE = "opening-round";
export const OPENING_ROUND_JOB = "opening-round";

export type OpeningRoundState = "pending" | "settling" | "delivering" | "delivered" | "no-round" | "rejected" | "stalled";
const SETTLING: OpeningRoundState[] = ["pending", "settling"];
const UNFINISHED: OpeningRoundState[] = ["pending", "settling", "delivering"];
const unfinished = inArray(records.state, UNFINISHED);

export type OpeningRoundRecord = Readonly<{
  network: string;
  launchId: string;
  memeType: string;
  quoteType: string;
  state: OpeningRoundState;
  roundEndMs: bigint | null;
  settledAt: Date | null;
  biddersCursor: string | null;
  attempts: number;
  settleDigests: readonly string[];
  detectedAt: Date;
}>;

const COLUMNS = {
  network: records.network,
  launchId: records.launchId,
  memeType: records.memeType,
  quoteType: records.quoteType,
  state: records.state,
  roundEndMs: records.roundEndMs,
  settledAt: records.settledAt,
  biddersCursor: records.biddersCursor,
  attempts: records.attempts,
  settleDigests: records.settleDigests,
  detectedAt: records.detectedAt,
};

/** Records discovered launches as `pending`; one already recorded is kept as it is. */
export async function recordLaunches(transaction: TransactionContext, network: string, launches: readonly CurveLaunch[]): Promise<void> {
  await transactionDatabase(transaction.forModule(MODULE)).insert(records).values(launches.map((launch) => ({
    network,
    launchId: launch.launchId,
    memeType: launch.memeType,
    quoteType: launch.quoteType,
    createdCheckpoint: launch.createdCheckpoint,
    state: "pending" as const,
    nextEligibleAt: sql`now()`,
    detectedAt: sql`now()`,
    updatedAt: sql`now()`,
  }))).onConflictDoNothing({ target: [records.network, records.launchId] });
}

/**
 * Due records, settlement before delivery: up to `limit` `pending` or
 * `settling` records whose time has come, then delivery records with the
 * slots left. Each group oldest first, so a launch that just delivered a
 * batch waits behind the others (rotation).
 */
export async function dueRecords(pool: Pool, network: string, limit: number): Promise<OpeningRoundRecord[]> {
  const db = workerDatabase(pool, MODULE);
  const due = (states: OpeningRoundState[], count: number) => db.select(COLUMNS).from(records)
    .where(and(eq(records.network, network), inArray(records.state, states), lte(records.nextEligibleAt, sql`now()`)))
    .orderBy(asc(records.nextEligibleAt), asc(records.launchId)).limit(count);
  const settling = await due(SETTLING, limit);
  if (settling.length >= limit) return settling;
  return [...settling, ...(await due(["delivering"], limit - settling.length))];
}

/** Updates an unfinished record; false when it is already final (another worker closed it). */
async function update(pool: Pool, record: OpeningRoundRecord, changes: PgUpdateSetSource<typeof records>): Promise<boolean> {
  const rows = await workerDatabase(pool, MODULE).update(records).set({ ...changes, updatedAt: sql`now()` }).where(and(
    eq(records.network, record.network), eq(records.launchId, record.launchId), unfinished,
  )).returning({ key: records.launchId });
  return rows.length === 1;
}

const at = (delayMs: number) => sql`now() + ${delayMs} * INTERVAL '1 millisecond'`;

/** The round runs (or waits for share): `settling` with its end, read again at `nextMs` from now. */
export function recordSettling(pool: Pool, record: OpeningRoundRecord, roundEndMs: bigint | null, nextMs: number): Promise<boolean> {
  return update(pool, record, { state: "settling", roundEndMs, errorClass: null, nextEligibleAt: at(nextMs) });
}

/** A settle digest is written before its bytes are sent. */
export function recordSettleSubmission(pool: Pool, record: OpeningRoundRecord, digest: string): Promise<boolean> {
  return update(pool, record, {
    latestDigest: digest,
    settleDigests: sql`array_append(${records.settleDigests}, ${digest}::text)`,
  });
}

/** A delivery digest is written before its bytes are sent. */
export function recordDeliverySubmission(pool: Pool, record: OpeningRoundRecord, digest: string): Promise<boolean> {
  return update(pool, record, { latestDigest: digest });
}

/** Settled (by `by`, or by a wallet the node cannot name yet): delivery is due now. */
export function recordSettled(pool: Pool, record: OpeningRoundRecord, by: "worker" | "external" | null, roundEndMs: bigint | null): Promise<boolean> {
  return update(pool, record, {
    state: "delivering", settledBy: by, settledAt: sql`coalesce(${records.settledAt}, now())`,
    roundEndMs: sql`coalesce(${roundEndMs === null ? null : roundEndMs.toString()}::bigint, ${records.roundEndMs})`,
    attempts: 0, errorClass: null, nextEligibleAt: sql`now()`,
  });
}

/** One delivery transaction executed: its bidders are paid; the next batch is due now, behind the others. */
export function recordDelivered(pool: Pool, record: OpeningRoundRecord, bidders: number, cursor: string | null): Promise<boolean> {
  return update(pool, record, {
    deliveredBidders: sql`${records.deliveredBidders} + ${bidders}`,
    biddersCursor: cursor, attempts: 0, errorClass: null, nextEligibleAt: sql`now()`,
  });
}

/** Where the next delivery reads blast-infra's bidders list from. */
export function recordBiddersCursor(pool: Pool, record: OpeningRoundRecord, cursor: string | null): Promise<boolean> {
  return update(pool, record, { biddersCursor: cursor });
}

/** Final: every bid is delivered, the launch has no round, or the worker never signs for it again. */
export function recordClosed(
  pool: Pool,
  record: OpeningRoundRecord,
  state: "delivered" | "no-round" | "rejected" | "stalled",
  errorClass: string | null = null,
): Promise<boolean> {
  return update(pool, record, { state, errorClass, closedAt: sql`now()` });
}

/** Back off: revisited after `delayMs`; `failed` counts a failed attempt. */
export function recordRetry(pool: Pool, record: OpeningRoundRecord, errorClass: string, delayMs: number, failed = false): Promise<boolean> {
  return update(pool, record, {
    errorClass, nextEligibleAt: at(delayMs), attempts: sql`${records.attempts} + ${failed ? 1 : 0}`,
  });
}

/** Rounds that ended at or before `nowMs` and are not settled, oldest end first: the alert sweep. */
export async function unsettledRounds(pool: Pool, network: string, nowMs: number, limit: number) {
  return workerDatabase(pool, MODULE).select({ launchId: records.launchId, roundEndMs: records.roundEndMs, state: records.state })
    .from(records)
    .where(and(
      eq(records.network, network), isNull(records.settledAt), inArray(records.state, ["pending", "settling", "stalled"]),
      lte(records.roundEndMs, BigInt(nowMs)),
    ))
    .orderBy(asc(records.roundEndMs)).limit(limit);
}

export type OpeningBacklog = Readonly<{
  pending: number;
  settling: number;
  delivering: number;
  stalled: number;
  /** Ended rounds still unsettled. */
  unsettled: number;
}>;

export async function readBacklog(pool: Pool, network: string, nowMs: number): Promise<OpeningBacklog> {
  const rows = await workerDatabase(pool, MODULE).select({
    pending: sql`count(*) FILTER (WHERE ${records.state} = 'pending')`.mapWith(Number),
    settling: sql`count(*) FILTER (WHERE ${records.state} = 'settling')`.mapWith(Number),
    delivering: sql`count(*) FILTER (WHERE ${records.state} = 'delivering')`.mapWith(Number),
    stalled: sql`count(*) FILTER (WHERE ${records.state} = 'stalled')`.mapWith(Number),
    unsettled: sql`count(*) FILTER (WHERE ${records.settledAt} IS NULL AND ${records.state} IN ('pending', 'settling', 'stalled') AND ${records.roundEndMs} <= ${nowMs})`.mapWith(Number),
  }).from(records).where(and(eq(records.network, network), inArray(records.state, ["pending", "settling", "delivering", "stalled"])));
  const row = rows[0];
  return { pending: row?.pending ?? 0, settling: row?.settling ?? 0, delivering: row?.delivering ?? 0, stalled: row?.stalled ?? 0, unsettled: row?.unsettled ?? 0 };
}
