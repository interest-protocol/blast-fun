import type { Pool } from "pg";

import {
  autocommitRead,
  autocommitWrite,
} from "@blast/core/modules/database/transaction.ts";
import type { SponsorIntent } from "@blast/core/modules/sponsor/intents.ts";
import type { SponsorReservationState } from "./reservations.ts";

/** The states execute reads: every state that carries a pool reservation and bytes. */
export type SponsorExecutionState = Exclude<
  SponsorReservationState,
  "reserving" | "reservation_failed"
>;

/** A settled outcome: the effects' status and the net gas in MIST. */
export type SponsorExecutionOutcome = Readonly<{
  status: "success" | "failure";
  gasUsed: bigint;
}>;

/** A completed reservation as execute sees it. */
export type SponsorExecutionRow = Readonly<{
  id: string;
  privyDid: string;
  sender: string;
  /** Null exactly for a `withdraw` (migration 0074) and a `trade` (0089). */
  presaleId: string | null;
  intent: SponsorIntent;
  deploymentFingerprint?: string;
  txBytes: Uint8Array;
  digest: string;
  state: SponsorExecutionState;
  expiresAt: Date;
  submittedAt: Date | null;
  /** Set exactly when the state is `executed` or `failed_execution`. */
  outcome: SponsorExecutionOutcome | null;
}>;

/**
 * Execute's view of `presale_sponsor_reservations` (migration 0042). Every
 * transition is one conditional autocommit UPDATE whose row count says
 * whether this caller made it, so exactly one caller submits a reservation
 * and exactly one settles it. Times are the route's clock, never the
 * database's `now()` (Q-022).
 */
export type SponsorExecutionStore = Readonly<{
  /** The DID's reservation, or null for another account's, an unknown id, or a `reserving` or `reservation_failed` row. */
  find(id: string, privyDid: string): Promise<SponsorExecutionRow | null>;
  /** `reserved` → `submitted` while `expires_at` is after `now`; true when this call moved it. */
  submit(id: string, privyDid: string, now: Date): Promise<boolean>;
  /**
   * `reserved` → `expired` once `expires_at` is at or before `now`; true when
   * this call moved it. False means another request changed the row first
   * (for example submitted it with an earlier clock): answer from the row.
   */
  expire(id: string, privyDid: string, now: Date): Promise<boolean>;
  /**
   * `reserved` → `expired` now, whatever its `expires_at`: a reservation that
   * collected too many wrong signatures (execute's step 4). True when this
   * call moved it; false when another request changed it first.
   */
  revoke(id: string, privyDid: string): Promise<boolean>;
  /**
   * `submitted` or `unconfirmed` → `executed` (success) or `failed_execution`
   * (failure) with the outcome; true when this call settled it. Effects are
   * facts, so they also settle a row an earlier call could not confirm.
   */
  settle(
    id: string,
    outcome: SponsorExecutionOutcome,
    now: Date,
  ): Promise<boolean>;
  /** `submitted` → `unconfirmed`; true when this call moved it. */
  unconfirm(id: string, now: Date): Promise<boolean>;
}>;

type Row = {
  id: string;
  privy_did: string;
  sender: string;
  presale_id: string | null;
  intent: SponsorIntent;
  deployment_fingerprint: string | null;
  tx_bytes: Buffer;
  digest: string;
  state: SponsorExecutionState;
  expires_at: Date;
  submitted_at: Date | null;
  effects_status: "success" | "failure" | null;
  gas_used: string | null;
};

const MODULE = "presale-sponsor";
const TABLE = "presale_sponsor_reservations";

/** Execute's store over the reservation table; each method is one short autocommit statement. */
export class PostgresSponsorExecutions implements SponsorExecutionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async find(
    id: string,
    privyDid: string,
  ): Promise<SponsorExecutionRow | null> {
    const result = await autocommitRead<Row>(
      this.#pool,
      MODULE,
      `SELECT id::text AS id, privy_did, sender, presale_id, intent, deployment_fingerprint, tx_bytes, digest, state,
              expires_at, submitted_at, effects_status, gas_used::text AS gas_used
       FROM ${TABLE}
       WHERE id = $1 AND privy_did = $2 AND state NOT IN ('reserving', 'reservation_failed')`,
      [id, privyDid],
      { label: "presale.sponsor_execute_find" },
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      privyDid: row.privy_did,
      sender: row.sender,
      presaleId: row.presale_id,
      intent: row.intent,
      ...(row.deployment_fingerprint !== null && { deploymentFingerprint: row.deployment_fingerprint }),
      txBytes: Uint8Array.from(row.tx_bytes),
      digest: row.digest,
      state: row.state,
      expiresAt: row.expires_at,
      submittedAt: row.submitted_at,
      outcome:
        row.effects_status !== null && row.gas_used !== null
          ? { status: row.effects_status, gasUsed: BigInt(row.gas_used) }
          : null,
    };
  }

  async submit(id: string, privyDid: string, now: Date): Promise<boolean> {
    const result = await autocommitWrite(
      this.#pool,
      MODULE,
      TABLE,
      `UPDATE ${TABLE} SET state = 'submitted', submitted_at = $3, updated_at = now()
       WHERE id = $1 AND privy_did = $2 AND state = 'reserved' AND expires_at > $3`,
      [id, privyDid, now],
    );
    return result.rowCount === 1;
  }

  async expire(id: string, privyDid: string, now: Date): Promise<boolean> {
    const result = await autocommitWrite(
      this.#pool,
      MODULE,
      TABLE,
      `UPDATE ${TABLE} SET state = 'expired', updated_at = now()
       WHERE id = $1 AND privy_did = $2 AND state = 'reserved' AND expires_at <= $3`,
      [id, privyDid, now],
    );
    return result.rowCount === 1;
  }

  async revoke(id: string, privyDid: string): Promise<boolean> {
    const result = await autocommitWrite(
      this.#pool,
      MODULE,
      TABLE,
      `UPDATE ${TABLE} SET state = 'expired', updated_at = now()
       WHERE id = $1 AND privy_did = $2 AND state = 'reserved'`,
      [id, privyDid],
    );
    return result.rowCount === 1;
  }

  async settle(
    id: string,
    outcome: SponsorExecutionOutcome,
    now: Date,
  ): Promise<boolean> {
    const result = await autocommitWrite(
      this.#pool,
      MODULE,
      TABLE,
      `UPDATE ${TABLE}
       SET state = CASE WHEN $2 = 'success' THEN 'executed' ELSE 'failed_execution' END,
           effects_status = $2, gas_used = $3, completed_at = $4, updated_at = now()
       WHERE id = $1 AND state IN ('submitted', 'unconfirmed')`,
      [id, outcome.status, outcome.gasUsed.toString(), now],
    );
    return result.rowCount === 1;
  }

  async unconfirm(id: string, now: Date): Promise<boolean> {
    const result = await autocommitWrite(
      this.#pool,
      MODULE,
      TABLE,
      `UPDATE ${TABLE} SET state = 'unconfirmed', completed_at = $2, updated_at = now()
       WHERE id = $1 AND state = 'submitted'`,
      [id, now],
    );
    return result.rowCount === 1;
  }
}
