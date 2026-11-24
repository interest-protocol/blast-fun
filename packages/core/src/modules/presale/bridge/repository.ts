import { z } from "zod";
import type { Pool } from "pg";

import {
  autocommitRead,
  autocommitWrite,
} from "@blast/core/modules/database/transaction.ts";
import {
  CCTP_SOURCE_DOMAINS,
  type BridgeActivationRecord,
  type BridgeActivationRecords,
  type BridgeTransfer,
  type BridgeTransfers,
  type BridgeTransition,
  type NewBridgeActivationRecord,
} from "./contracts.ts";

const MODULE = "presale-bridge";
/** A transfer whose `next_poll_at` is at or past this is parked (the relayer sets 9999-12-31). */
const PARKED_FROM = "9999-01-01T00:00:00Z";
const TRANSFERS = "presale_bridge_transfers";
const ACTIVATIONS = "presale_bridge_activations";

const TRANSFER_COLUMNS = `id, source, source_domain, tx_hash, sui_address, amount::text AS amount, presale_id,
  privy_did, status, sent_at, attested_at, minted_at, failed_at, error, nonce, message, attestation,
  sui_digest, next_poll_at, poll_count, circle_not_found_at, observed_from`;

type TransferRow = {
  id: string;
  source: BridgeTransfer["source"];
  source_domain: number;
  tx_hash: string;
  sui_address: string;
  amount: string;
  presale_id: string;
  privy_did: string | null;
  status: BridgeTransfer["status"];
  sent_at: Date;
  attested_at: Date | null;
  minted_at: Date | null;
  failed_at: Date | null;
  error: string | null;
  nonce: string | null;
  message: string | null;
  attestation: string | null;
  sui_digest: string | null;
  next_poll_at: Date;
  poll_count: number;
  circle_not_found_at: Date | null;
  observed_from: Date | null;
};

function transfer(row: TransferRow): BridgeTransfer {
  return Object.freeze({
    id: row.id,
    source: row.source,
    sourceDomain: row.source_domain,
    txHash: row.tx_hash,
    suiAddress: row.sui_address,
    amount: row.amount,
    presaleId: row.presale_id,
    privyDid: row.privy_did,
    status: row.status,
    sentAt: row.sent_at,
    attestedAt: row.attested_at,
    mintedAt: row.minted_at,
    failedAt: row.failed_at,
    error: row.error,
    nonce: row.nonce,
    message: row.message,
    attestation: row.attestation,
    suiDigest: row.sui_digest,
    nextPollAt: row.next_poll_at,
    pollCount: row.poll_count,
    circleNotFoundAt: row.circle_not_found_at,
    observedFrom: row.observed_from,
  });
}

/**
 * The transfer registry in `presale_bridge_transfers` (migration 0044). The
 * web runtime registers and reads; the bridge relayer worker (`blast_watcher`)
 * reads and calls the transitions. Each transition is one conditional UPDATE
 * that names the statuses it may leave, so a backward or repeated move, a
 * move out of a terminal status, and a race between two workers all change
 * nothing and return the transfer as it is.
 *
 * Each stamp is `greatest(previous stamps, at ?? now())`: a caller's clock
 * that is behind the database's, or a millisecond `at` read back from a
 * microsecond stamp, is clamped instead of failing the table's order CHECKs,
 * which stay as the backstop.
 */
export class PostgresBridgeTransfers implements BridgeTransfers {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async register(input: Parameters<BridgeTransfers["register"]>[0]) {
    const inserted = await autocommitWrite<typeof MODULE, { id: string }>(
      this.#pool,
      MODULE,
      TRANSFERS,
      `INSERT INTO presale_bridge_transfers (source, source_domain, tx_hash, sui_address, amount, presale_id, privy_did)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source, tx_hash) DO NOTHING
       RETURNING id`,
      [
        input.source,
        CCTP_SOURCE_DOMAINS[input.source],
        input.txHash,
        input.suiAddress,
        input.amount,
        input.presaleId,
        input.privyDid,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id) return { id, created: true };
    const existing = await autocommitRead<{ id: string }>(
      this.#pool,
      MODULE,
      "SELECT id FROM presale_bridge_transfers WHERE source = $1 AND tx_hash = $2",
      [input.source, input.txHash],
      { label: "presale.bridge.register" },
    );
    const found = existing.rows[0]?.id;
    if (!found) throw new Error("A conflicting bridge transfer was not found.");
    // T-021 B-010: a repeat registration of a parked never-seen transfer re-arms it for one more
    // observation window (same id). Anything else is left as it is.
    await autocommitWrite(
      this.#pool,
      MODULE,
      TRANSFERS,
      `UPDATE presale_bridge_transfers
       SET next_poll_at = now(), observed_from = greatest(sent_at, now()), circle_not_found_at = NULL
       WHERE id = $1 AND status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL
         AND next_poll_at >= '${PARKED_FROM}'`,
      [found],
    );
    return { id: found, created: false };
  }

  /**
   * The account's registrations Circle has not attested yet (`sent`), counted
   * up to `limit` by the partial index of migration 0102 (review L6).
   */
  async openRegistrations(privyDid: string, limit: number): Promise<number> {
    const result = await autocommitRead<{ open: number }>(
      this.#pool,
      MODULE,
      `SELECT count(*)::int AS open FROM (
         SELECT 1 FROM presale_bridge_transfers WHERE privy_did = $1 AND status = 'sent' AND privy_did IS NOT NULL LIMIT $2
       ) open`,
      [privyDid, limit],
      { label: "presale.bridge.open_registrations" },
    );
    return result.rows[0]?.open ?? 0;
  }

  async find(id: string): Promise<BridgeTransfer | null> {
    const result = await autocommitRead<TransferRow>(
      this.#pool,
      MODULE,
      `SELECT ${TRANSFER_COLUMNS} FROM presale_bridge_transfers WHERE id = $1`,
      [id],
      { label: "presale.bridge.transfer" },
    );
    return result.rows[0] ? transfer(result.rows[0]) : null;
  }

  /**
   * The transfer registered for one burn (unique on `(source, tx_hash)`), or
   * null. A read only: unlike `register`, it never re-arms a parked
   * transfer, so a reader polling a deposit (the social coins sheet) leaves
   * the relayer's queue alone.
   */
  async findByHash(
    source: BridgeTransfer["source"],
    txHash: string,
  ): Promise<BridgeTransfer | null> {
    const result = await autocommitRead<TransferRow>(
      this.#pool,
      MODULE,
      `SELECT ${TRANSFER_COLUMNS} FROM presale_bridge_transfers WHERE source = $1 AND tx_hash = $2`,
      [source, txHash],
      { label: "presale.bridge.transfer_by_hash" },
    );
    return result.rows[0] ? transfer(result.rows[0]) : null;
  }

  async #transition(sql: string, values: readonly unknown[]): Promise<BridgeTransition> {
    const result = await autocommitWrite<typeof MODULE, TransferRow>(
      this.#pool,
      MODULE,
      TRANSFERS,
      sql,
      values,
    );
    const row = result.rows[0];
    if (row) return Object.freeze({ applied: true, transfer: transfer(row) });
    return Object.freeze({ applied: false, transfer: await this.find(String(values[0])) });
  }

  /** `sent → attested`, or a late attestation of an `attestation_timeout` failure (its stamp and error are cleared). */
  markAttested(id: string, input: Parameters<BridgeTransfers["markAttested"]>[1]) {
    return this.#transition(
      `UPDATE presale_bridge_transfers
       SET status = 'attested', attested_at = greatest(sent_at, coalesce($2::timestamptz, now())), message = $3, attestation = $4,
           nonce = coalesce($5, nonce), failed_at = NULL, error = NULL, circle_not_found_at = NULL
       WHERE id = $1
         AND (status = 'sent' OR (status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL))
       RETURNING ${TRANSFER_COLUMNS}`,
      [id, input.at ?? null, input.message, input.attestation, input.nonce ?? null],
    );
  }

  /** `attested → minted`, with the Sui mint digest. */
  markMinted(id: string, input: Parameters<BridgeTransfers["markMinted"]>[1]) {
    return this.#transition(
      `UPDATE presale_bridge_transfers
       SET status = 'minted', minted_at = greatest(attested_at, coalesce($2::timestamptz, now())), sui_digest = $3
       WHERE id = $1 AND status = 'attested'
       RETURNING ${TRANSFER_COLUMNS}`,
      [id, input.at ?? null, input.suiDigest],
    );
  }

  /**
   * `sent` or `attested` → `failed`, with `invalid_burn`, `attestation_timeout`
   * or Circle's text; and (spec A-008, T-021) an `attestation_timeout` that was
   * never attested → `invalid_burn`, when a late message proves the burn
   * invalid. A refined failure leaves the due index, so it is not polled again.
   */
  markFailed(id: string, input: Parameters<BridgeTransfers["markFailed"]>[1]) {
    return this.#transition(
      `UPDATE presale_bridge_transfers
       SET status = 'failed', failed_at = greatest(sent_at, attested_at, coalesce($2::timestamptz, now())), error = $3
       WHERE id = $1
         AND (status IN ('sent', 'attested')
           OR ($3 = 'invalid_burn' AND status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL))
       RETURNING ${TRANSFER_COLUMNS}`,
      [id, input.at ?? null, input.error],
    );
  }

  /**
   * Replaces the stored attestation of an `attested` transfer with Circle's
   * newer one (T-021 Q-009: Circle re-signs when Sui's attesters rotate). The
   * message is never changed.
   */
  refreshAttestation(id: string, input: Readonly<{ message: string; attestation: string }>) {
    return this.#transition(
      `UPDATE presale_bridge_transfers SET attestation = $3
       WHERE id = $1 AND status = 'attested' AND message = $2 AND attestation IS DISTINCT FROM $3
       RETURNING ${TRANSFER_COLUMNS}`,
      [id, input.message, input.attestation],
    );
  }

  /**
   * One more poll of a transfer in flight, or of an attestation timeout that
   * a late attestation can still revive. `delayReason` replaces `error` when
   * given (null clears it), except on a timed-out transfer, which keeps its
   * failure text.
   */
  recordPoll(id: string, input: Parameters<BridgeTransfers["recordPoll"]>[1]) {
    return this.#transition(
      `UPDATE presale_bridge_transfers
       SET poll_count = poll_count + 1, next_poll_at = $2,
           error = CASE WHEN $4::boolean AND status <> 'failed' THEN $3 ELSE error END,
           circle_not_found_at = CASE WHEN $5::boolean IS NULL THEN circle_not_found_at WHEN $5::boolean THEN now() ELSE NULL END
       WHERE id = $1
         AND (status IN ('sent', 'attested')
           OR (status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL))
       RETURNING ${TRANSFER_COLUMNS}`,
      [
        id,
        input.nextPollAt,
        input.delayReason ?? null,
        input.delayReason !== undefined,
        input.circleNotFound ?? null,
      ],
    );
  }

  /**
   * The relayer worker's queue (T-021): up to `limit` transfers due now
   * (`next_poll_at ≤ now()`) among those in flight and the attestation
   * timeouts a late attestation can still revive (the partial index
   * `presale_bridge_transfers_due`), with the database's clock.
   *
   * Order (spec A-008, review R-002 B-009): `attested` transfers first; then
   * every transfer without durable evidence that Circle has never seen it
   * (new registrations and every row after a restart included); last, those
   * with that evidence (`circle_not_found_at`). Within each group the most
   * overdue first, so service under a saturated Circle budget is round-robin
   * and never starves a transfer.
   */
  async due(limit: number): Promise<Readonly<{ now: Date; transfers: readonly BridgeTransfer[] }>> {
    const result = await autocommitRead<TransferRow & { db_now: Date }>(
      this.#pool,
      MODULE,
      `SELECT ${TRANSFER_COLUMNS}, now() AS db_now FROM presale_bridge_transfers
       WHERE (status IN ('sent', 'attested') OR (status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL))
         AND next_poll_at <= now()
       ORDER BY CASE WHEN status = 'attested' THEN 0 WHEN circle_not_found_at IS NULL THEN 1 ELSE 2 END,
                next_poll_at, id
       LIMIT $1`,
      [limit],
      { label: "presale.bridge.due" },
    );
    const now = result.rows[0]?.db_now ?? (await this.now());
    return Object.freeze({ now, transfers: Object.freeze(result.rows.map(transfer)) });
  }

  /** The database's clock. */
  async now(): Promise<Date> {
    const result = await autocommitRead<{ now: Date }>(
      this.#pool,
      MODULE,
      "SELECT now() AS now",
      [],
      { label: "presale.bridge.now" },
    );
    return result.rows[0]!.now;
  }

  /**
   * `attested` transfers split by whether the configured Sui CCTP package
   * receives their message version (`receivableVersion`, the message's first
   * 4 bytes): those receivable and attested for longer than `olderThanMs`
   * feed `bridge_stuck` (`count`, the oldest); every other one (a V2 message
   * while the switch is V1) is `versionPending`, which feeds
   * `bridge_version_pending` instead and never `bridge_stuck`.
   */
  async stuckAttested(
    olderThanMs: number,
    receivableVersion: number,
  ): Promise<
    Readonly<{
      count: number;
      oldestId: string | null;
      oldestAttestedAt: Date | null;
      versionPending: number;
    }>
  > {
    const prefix = `0x${receivableVersion.toString(16).padStart(8, "0")}`;
    const result = await autocommitRead<{
      count: number;
      oldest_id: string | null;
      oldest_attested_at: Date | null;
      version_pending: number;
    }>(
      this.#pool,
      MODULE,
      `SELECT count(*) FILTER (WHERE receivable AND old)::int AS count,
              (array_agg(id ORDER BY attested_at, id) FILTER (WHERE receivable AND old))[1] AS oldest_id,
              min(attested_at) FILTER (WHERE receivable AND old) AS oldest_attested_at,
              count(*) FILTER (WHERE NOT receivable)::int AS version_pending
       FROM (
         SELECT id, attested_at, left(message, 10) = $2 AS receivable,
                attested_at <= now() - $1 * INTERVAL '1 millisecond' AS old
         FROM presale_bridge_transfers WHERE status = 'attested'
       ) AS attested`,
      [olderThanMs, prefix],
      { label: "presale.bridge.stuck" },
    );
    const row = result.rows[0];
    return Object.freeze({
      count: row?.count ?? 0,
      oldestId: row?.oldest_id ?? null,
      oldestAttestedAt: row?.oldest_attested_at ?? null,
      versionPending: row?.version_pending ?? 0,
    });
  }
}

const ACTIVATION_COLUMNS = `id::text AS id, recorded_at, recorded_by, kind, forwarding, relayer_address, hook_data,
  sui_cctp, checklist, complete, problems`;

type ActivationRow = {
  id: string;
  recorded_at: Date;
  recorded_by: string;
  kind: BridgeActivationRecord["kind"];
  forwarding: BridgeActivationRecord["forwarding"];
  relayer_address: string | null;
  hook_data: string | null;
  sui_cctp: BridgeActivationRecord["suiCctp"];
  checklist: BridgeActivationRecord["checklist"];
  complete: boolean;
  problems: BridgeActivationRecord["problems"];
};

function activation(row: ActivationRow): BridgeActivationRecord {
  return Object.freeze({
    id: row.id,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    kind: row.kind,
    forwarding: row.forwarding,
    relayerAddress: row.relayer_address,
    hookData: row.hook_data,
    suiCctp: row.sui_cctp,
    checklist: row.checklist,
    complete: row.complete,
    problems: Object.freeze([...row.problems]),
  });
}

/**
 * The activation records in `presale_bridge_activations` (migration 0044):
 * inserted, never changed or deleted, so the history stays. The newest
 * record governs the bridge.
 */
export class PostgresBridgeActivations implements BridgeActivationRecords {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(record: NewBridgeActivationRecord): Promise<BridgeActivationRecord> {
    const result = await autocommitWrite<typeof MODULE, ActivationRow>(
      this.#pool,
      MODULE,
      ACTIVATIONS,
      `INSERT INTO presale_bridge_activations
         (recorded_by, kind, forwarding, relayer_address, hook_data, sui_cctp, checklist, complete, problems)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::text[])
       RETURNING ${ACTIVATION_COLUMNS}`,
      [
        record.recordedBy,
        record.kind,
        record.forwarding,
        record.relayerAddress,
        record.hookData,
        record.suiCctp === null ? null : JSON.stringify(record.suiCctp),
        JSON.stringify(record.checklist),
        record.complete,
        [...record.problems],
      ],
    );
    return activation(result.rows[0]!);
  }

  async latest(): Promise<BridgeActivationRecord | null> {
    return (await this.history(1))[0] ?? null;
  }

  async anyComplete(): Promise<boolean> {
    const result = await autocommitRead<{ any: boolean }>(
      this.#pool,
      MODULE,
      "SELECT EXISTS (SELECT 1 FROM presale_bridge_activations WHERE complete) AS any",
      [],
      { label: "presale.bridge.activation" },
    );
    return result.rows[0]?.any === true;
  }

  async history(limit: number): Promise<readonly BridgeActivationRecord[]> {
    if (!z.number().int().safe().min(1).max(1_000).safeParse(limit).success)
      throw new RangeError("The history limit must be 1 to 1000.");
    const result = await autocommitRead<ActivationRow>(
      this.#pool,
      MODULE,
      // Sort on the bigint column: the output alias `id` is text, and "9" sorts after "10" (B-001).
      `SELECT ${ACTIVATION_COLUMNS} FROM presale_bridge_activations ORDER BY presale_bridge_activations.id DESC LIMIT $1`,
      [limit],
      { label: "presale.bridge.activation" },
    );
    return Object.freeze(result.rows.map(activation));
  }
}
