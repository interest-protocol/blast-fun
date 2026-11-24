import type { Pool } from "pg";

import {
  autocommitRead,
  autocommitWrite,
  withTransaction,
  type ModuleTransaction,
} from "@blast/core/modules/database/transaction.ts";
import type {
  ReplaceableSponsorIntent,
  SponsorIntent,
} from "@blast/core/modules/sponsor/intents.ts";

/** Unexpired, unexecuted reservations one Privy account may hold at once. */
export const MAX_OPEN_SPONSOR_RESERVATIONS = 2;
/** How long handed-out bytes stay executable through the route (the response's `expires_at_ms` is 10 s earlier). */
export const SPONSOR_RESERVATION_SECONDS = 120;
/** A claim's window to complete: a crash between claim and completion holds the slot no longer than this plus the reservation. */
export const SPONSOR_CLAIM_WINDOW_MS = 5_000;

/**
 * A reservation's life in `presale_sponsor_reservations`:
 *
 * - The sponsor route claims a `reserving` row, which has no bytes yet, and
 *   completes it to `reserved` with the bytes. (`reservation_failed` is only
 *   in rows from the retired gas pool, which could refuse.)
 * - Execute moves a `reserved` row to `submitted`, then to `executed`,
 *   `failed_execution` or `unconfirmed`.
 * - An unexecuted row past `expires_at` becomes `expired`.
 *
 * Only `reserved` and later rows carry bytes. Readers
 * other than the cap must ignore `reserving` and `reservation_failed` rows.
 */
export const SPONSOR_RESERVATION_STATES = [
  "reserving",
  "reservation_failed",
  "reserved",
  "submitted",
  "executed",
  "failed_execution",
  "unconfirmed",
  "expired",
] as const;
export type SponsorReservationState =
  (typeof SPONSOR_RESERVATION_STATES)[number];

/**
 * The states that count against `MAX_OPEN_SPONSOR_RESERVATIONS` until
 * `expires_at`. A `reserving` row counts, so a crash between claim and
 * completion holds the slot until its claim expiry.
 */
export const OPEN_SPONSOR_RESERVATION_STATES = [
  "reserving",
  "reserved",
  "submitted",
] as const satisfies readonly SponsorReservationState[];

/** What the route knows when it claims a slot, before it builds the bytes. */
export type SponsorReservationClaim = Readonly<{
  /** Server-owned stable identity; completion is inserted atomically for recoverable workflows. */
  id?: string;
  completion?: SponsorReservationCompletion;
  privyDid: string;
  sender: string;
  /** Null exactly for `withdraw` (migration 0074) and `trade` (0089). */
  presaleId: string | null;
  intent: SponsorIntent;
  deploymentFingerprint?: string;
  /** MIST. */
  gasBudget: bigint;
  /** When the claim has completed at the latest (column `pool_deadline`, named for the retired gas pool). */
  poolDeadline: Date;
  /** The claim window plus the reservation lifetime: a crash keeps the slot no longer. */
  expiresAt: Date;
}>;

/**
 * The one source of a claim's times (Q-021): the pool deadline (claim time +
 * the pool timeout) and the claim expiry (the pool deadline + the pool's
 * reservation lifetime). Stores read the stored values, never re-derive them.
 */
export function sponsorClaimWindow(
  claimedAt: Date,
): Readonly<{ poolDeadline: Date; expiresAt: Date }> {
  const poolDeadline = new Date(claimedAt.getTime() + SPONSOR_CLAIM_WINDOW_MS);
  return {
    poolDeadline,
    expiresAt: new Date(
      poolDeadline.getTime() + SPONSOR_RESERVATION_SECONDS * 1_000,
    ),
  };
}

/** What the route adds when it completes the row. */
export type SponsorReservationCompletion = Readonly<{
  /** The full `TransactionData` BCS the browser signs. */
  txBytes: Uint8Array;
  /** The digest of `txBytes`: the sponsored path's pre-submit registration. */
  digest: string;
  /** The reservation time + 120 s − 10 s. */
  expiresAt: Date;
}>;

/**
 * The claim's outcome:
 * - `claimed`: a `reserving` row now holds the slot;
 * - `full`: the account is at the cap, with the earliest time a slot may free;
 * - `busy`: the account's lock could not be had within the lock timeout.
 */
export type SponsorClaimResult =
  | Readonly<{ status: "claimed"; id: string }>
  | Readonly<{ status: "full"; nextExpiry: Date | null }>
  | Readonly<{ status: "busy" }>;

export type CompletedSponsorReservation = SponsorReservationCompletion & Readonly<{
  id: string;
  privyDid: string;
  sender: string;
  presaleId: string | null;
  intent: SponsorIntent;
  gasBudget: bigint;
}>;

export type SponsorBudgetRefusal = "presale_sponsor_ip" | "presale_sponsor_account_daily" | "presale_sponsor_global" | "open_reservations" | "claim_busy";
export type SponsorBudgetAttempt = Readonly<{ state: "started" | "completed" | "refused"; refusalReason: SponsorBudgetRefusal | null }>;

/** An internal keyed workflow has a definite retained refusal, rather than ambiguous consumption. */
export class KeyedSponsorRefusal extends Error {
  readonly reason: SponsorBudgetRefusal;
  constructor(reason: SponsorBudgetRefusal) {
    super("Sponsorship was refused for this withdrawal.");
    this.name = "KeyedSponsorRefusal";
    this.reason = reason;
  }
}

/** Only a never-published withdrawal may call this inside its fenced ledger transaction.
 * Locking the reservation serializes with execute's reserved -> submitted CAS;
 * a submitted or settled reservation always keeps its chain reconciliation path.
 */
async function expireUnsubmittedReservation(
  sponsor: ModuleTransaction<"presale-sponsor">,
  request: Readonly<{ reservationId: string; privyDid: string; sender: string }>,
  at: Date,
  intent: ReplaceableSponsorIntent,
): Promise<boolean> {
  const result = await sponsor.read<{ state: SponsorReservationState; submitted_at: Date | null; expires_at: Date }>(
    `SELECT state, submitted_at, expires_at FROM presale_sponsor_reservations
     WHERE id = $1::uuid AND privy_did = $2 AND sender = $3 AND presale_id IS NULL AND intent = $4 FOR UPDATE`,
    [request.reservationId, request.privyDid, request.sender, intent]);
  const row = result.rows[0];
  if (!row || row.submitted_at !== null || row.expires_at > at) return false;
  if (row.state === "expired") return true;
  if (row.state !== "reserved") return false;
  const expired = await sponsor.write("presale_sponsor_reservations",
    `UPDATE presale_sponsor_reservations SET state = 'expired', updated_at = now()
     WHERE id = $1::uuid AND state = 'reserved' AND submitted_at IS NULL AND expires_at <= $2`,
    [request.reservationId, at]);
  return expired.rowCount === 1;
}

export function expireUnsubmittedBridgeWithdrawal(sponsor: ModuleTransaction<"presale-sponsor">, request: Readonly<{ reservationId: string; privyDid: string; sender: string }>, at: Date): Promise<boolean> {
  return expireUnsubmittedReservation(sponsor, request, at, "bridge_withdraw");
}

/** A retained create plan may be replaced only after execute has lost the ability to submit it. */
export function expireUnsubmittedCreation(sponsor: ModuleTransaction<"presale-sponsor">, request: Readonly<{ reservationId: string; privyDid: string; sender: string }>, at: Date): Promise<boolean> {
  return expireUnsubmittedReservation(sponsor, request, at, "create");
}

export type SponsorReservationStore = Readonly<{
  /** Exact retained bytes, including after expiry/execution, for a server-owned idempotency key. */
  completed?(id: string): Promise<CompletedSponsorReservation | null>;
  /** Durable once-only permission to attempt shared budget consumption. Never automatically reset. */
  beginBudgetAttempt?(id: string, now: Date): Promise<boolean>;
  budgetAttempt?(id: string): Promise<SponsorBudgetAttempt | null>;
  refuseBudgetAttempt?(id: string, reason: SponsorBudgetRefusal, now: Date): Promise<void>;
  /**
   * The DID's open reservations at `now` (`reserving` included), and
   * `nextExpiry`: the earliest time one of them may free a slot (a running
   * claim's pool deadline, else an expiry).
   */
  open(
    privyDid: string,
    now: Date,
  ): Promise<Readonly<{ count: number; nextExpiry: Date | null }>>;
  /**
   * One short transaction: it takes the per-DID lock, rechecks the open count
   * at `now`, and inserts a `reserving` row when a slot is free. No connection
   * is held after it returns.
   */
  claim(claim: SponsorReservationClaim, now: Date): Promise<SponsorClaimResult>;
  /**
   * Completes a `reserving` row to `reserved`. Throws, changing nothing, when
   * the row is not `reserving` or its claim expired by `now` (the route's
   * clock, the same one `open` and `claim` count with): a stalled completion
   * never revives a slot the cap stopped counting (Q-016).
   */
  complete(
    id: string,
    completion: SponsorReservationCompletion,
    now: Date,
  ): Promise<void>;
  /** Counts one `target_not_allowed` refusal in `at`'s UTC hour under `reason`. */
  countRefusal(reason: string, at: Date): Promise<void>;
}>;

/** Longest stored refusal reason. */
const REASON_LENGTH = 160;

/**
 * A refusal reason as a bounded counting key: object IDs, addresses and
 * numbers become placeholders, so one cause counts as one reason whatever
 * objects a transaction names.
 */
export function refusalReasonKey(reason: string): string {
  const key = reason
    .replace(/0x[0-9a-fA-F]+/g, "0x…")
    .replace(/\b[0-9]+\b/g, "N")
    .replace(/[^\x20-\x7e…]/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_LENGTH);
  return key || "unspecified";
}

const MODULE = "presale-sponsor";
/**
 * The earliest time one of the open rows may free a slot (Q-017): a
 * `reserving` claim's stored pool deadline while it is ahead of now (`$2`),
 * else the row's `expires_at`.
 */
const NEXT_CHANGE = `min(CASE WHEN state = 'reserving' AND pool_deadline > $2 THEN pool_deadline ELSE expires_at END) AS next_expiry`;
const OPEN_STATES = `('${OPEN_SPONSOR_RESERVATION_STATES.join("', '")}')`;
/** PostgreSQL's `lock_not_available`: the lock timeout ran out. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * The reservation store in `presale_sponsor_reservations` and the refusal
 * counts in `presale_sponsor_refusal_counts` (migration 0042). No method holds
 * a connection beyond its own short statements.
 */
export class PostgresSponsorReservations implements SponsorReservationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async beginBudgetAttempt(id: string, now: Date): Promise<boolean> {
    const result = await autocommitWrite(this.#pool, MODULE, "presale_sponsor_budget_attempts",
      `INSERT INTO presale_sponsor_budget_attempts (reservation_id, attempted_at, state)
       VALUES ($1::uuid, $2, 'started') ON CONFLICT (reservation_id) DO NOTHING`, [id, now]);
    return result.rowCount === 1;
  }

  async budgetAttempt(id: string): Promise<SponsorBudgetAttempt | null> {
    const result = await autocommitRead<{ state: SponsorBudgetAttempt["state"]; refusal_reason: SponsorBudgetRefusal | null }>(this.#pool, MODULE,
      `SELECT state, refusal_reason FROM presale_sponsor_budget_attempts WHERE reservation_id = $1::uuid`, [id], { label: "presale.sponsor_budget_replay" });
    const row = result.rows[0];
    return row ? { state: row.state, refusalReason: row.refusal_reason } : null;
  }

  async refuseBudgetAttempt(id: string, reason: SponsorBudgetRefusal, now: Date): Promise<void> {
    const result = await autocommitWrite(this.#pool, MODULE, "presale_sponsor_budget_attempts",
      `UPDATE presale_sponsor_budget_attempts SET state = 'refused', refusal_reason = $2, completed_at = $3
       WHERE reservation_id = $1::uuid AND state = 'started'`, [id, reason, now]);
    if (result.rowCount !== 1) throw new Error("The sponsor budget attempt cannot be refused.");
  }

  async completed(id: string): Promise<CompletedSponsorReservation | null> {
    const result = await autocommitRead<{
      id: string; privy_did: string; sender: string; presale_id: string | null;
      intent: SponsorIntent; gas_budget: string; tx_bytes: Buffer; digest: string; expires_at: Date;
    }>(this.#pool, MODULE,
      `SELECT id::text, privy_did, sender, presale_id, intent, gas_budget::text, tx_bytes, digest, expires_at
       FROM presale_sponsor_reservations WHERE id = $1::uuid AND tx_bytes IS NOT NULL`,
      [id], { label: "presale.sponsor_replay" });
    const row = result.rows[0];
    return row ? {
      id: row.id, privyDid: row.privy_did, sender: row.sender, presaleId: row.presale_id,
      intent: row.intent, gasBudget: BigInt(row.gas_budget), txBytes: row.tx_bytes,
      digest: row.digest, expiresAt: row.expires_at,
    } : null;
  }

  async open(privyDid: string, now: Date) {
    const result = await autocommitRead<{
      count: number;
      next_expiry: Date | null;
    }>(
      this.#pool,
      MODULE,
      `SELECT count(*)::int AS count, ${NEXT_CHANGE}
       FROM presale_sponsor_reservations
       WHERE privy_did = $1 AND state IN ${OPEN_STATES} AND expires_at > $2`,
      [privyDid, now],
      { label: "presale.sponsor_open" },
    );
    const row = result.rows[0];
    return { count: row?.count ?? 0, nextExpiry: row?.next_expiry ?? null };
  }

  async claim(
    claim: SponsorReservationClaim,
    now: Date,
  ): Promise<SponsorClaimResult> {
    try {
      return await withTransaction(
        this.#pool,
        async (transaction): Promise<SponsorClaimResult> => {
          // One account's claims take turns; each holds the lock for two short statements only.
          await transaction.read(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`presale_sponsor:${claim.privyDid}`],
          );
          const open = await transaction.read<{
            count: number;
            next_expiry: Date | null;
          }>(
            `SELECT count(*)::int AS count, ${NEXT_CHANGE} FROM presale_sponsor_reservations
             WHERE privy_did = $1 AND state IN ${OPEN_STATES} AND expires_at > $2`,
            [claim.privyDid, now],
          );
          const row = open.rows[0];
          if ((row?.count ?? 0) >= MAX_OPEN_SPONSOR_RESERVATIONS)
            return { status: "full", nextExpiry: row?.next_expiry ?? null };
          const inserted = await transaction
            .forModule(MODULE)
            .write<{ id: string }>(
              "presale_sponsor_reservations",
              `INSERT INTO presale_sponsor_reservations
               (privy_did, sender, presale_id, intent, gas_budget, pool_deadline, expires_at, state, id, tx_bytes, digest, deployment_fingerprint)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::uuid, gen_random_uuid()), $10, $11, $12)
             ON CONFLICT (id) DO NOTHING
             RETURNING id::text AS id`,
              [
                claim.privyDid,
                claim.sender,
                claim.presaleId,
                claim.intent,
                claim.gasBudget.toString(),
                claim.poolDeadline,
                claim.completion?.expiresAt ?? claim.expiresAt,
                claim.completion ? "reserved" : "reserving",
                claim.id ?? null,
                claim.completion ? Buffer.from(claim.completion.txBytes) : null,
                claim.completion?.digest ?? null,
                claim.deploymentFingerprint ?? null,
              ],
            );
          if (inserted.rows[0] && claim.id && claim.completion) {
            const completed = await transaction.forModule(MODULE).write("presale_sponsor_budget_attempts",
              `UPDATE presale_sponsor_budget_attempts SET state = 'completed', completed_at = $2
               WHERE reservation_id = $1::uuid AND state = 'started'`, [claim.id, now]);
            if (completed.rowCount !== 1) throw new Error("The keyed reservation has no active budget attempt.");
          }
          return inserted.rows[0]
            ? { status: "claimed", id: inserted.rows[0].id }
            : { status: "busy" };
        },
        { label: "presale.sponsor_claim" },
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === LOCK_NOT_AVAILABLE)
        return { status: "busy" };
      throw error;
    }
  }

  async complete(
    id: string,
    completion: SponsorReservationCompletion,
    now: Date,
  ) {
    const result = await autocommitWrite(
      this.#pool,
      MODULE,
      "presale_sponsor_reservations",
      `UPDATE presale_sponsor_reservations
       SET state = 'reserved', tx_bytes = $2, digest = $3, expires_at = $4, updated_at = now()
       WHERE id = $1 AND state = 'reserving' AND expires_at > $5`,
      [
        id,
        Buffer.from(completion.txBytes),
        completion.digest,
        completion.expiresAt,
        now,
      ],
    );
    if (result.rowCount !== 1)
      throw new Error("The sponsor reservation is no longer being reserved.");
  }

  async countRefusal(reason: string, at: Date) {
    // The UTC hour as ISO text; the table checks it in UTC whatever the session TimeZone (B-004).
    const hour = new Date(
      Math.floor(at.getTime() / 3_600_000) * 3_600_000,
    ).toISOString();
    await autocommitWrite(
      this.#pool,
      MODULE,
      "presale_sponsor_refusal_counts",
      `INSERT INTO presale_sponsor_refusal_counts (hour, reason, count) VALUES ($1, $2, 1)
       ON CONFLICT (hour, reason) DO UPDATE SET count = presale_sponsor_refusal_counts.count + 1`,
      [hour, refusalReasonKey(reason)],
    );
  }
}
