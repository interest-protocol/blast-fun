import { z } from "zod";
import { randomUUID } from "node:crypto";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  isSocialTransactionFailure,
  SOCIAL_TRANSACTION_KINDS,
  type SocialTransactionFailure,
  type SocialTransactionKind,
  type SocialTransactionState,
} from "../contracts/transactions.ts";

/**
 * The one helper every money path logs through (R3-27): a row of
 * `social_transactions` (migration 0084) per transaction the product sends
 * for an account, written in the caller's own transaction so it commits or
 * rolls back with the path's own write.
 *
 * `logTransaction` is idempotent and only moves a row forward. The first
 * call for an `(account, idempotency key)` records the row with whatever is
 * known so far (no digest yet, a digest, or already settled); any later call
 * with the same key logs nothing new, and only adds what the stored row
 * lacks: its digest, then its outcome. A stale call (it knows less than the
 * row) changes nothing. A call that contradicts the row (other facts,
 * another digest, the opposite outcome) is a `TransactionLogConflict`, and
 * nothing is written.
 */

/** What was sent: the row's facts, never edited once logged. */
export type TransactionEntry = Readonly<{
  accountId: string;
  kind: SocialTransactionKind;
  /**
   * The path's own key for this transaction, unique per account: the same
   * write twice logs once. Namespaced by the path (`withdraw:<request id>`).
   */
  idempotencyKey: string;
  /** The product's own id (a UUID), when the path has one; generated otherwise. */
  txId?: string;
  presaleId?: string | null;
  coinType?: string | null;
  /** Atoms of `coinType`. */
  amount?: string | null;
  quoteType?: string | null;
  /** Atoms of `quoteType`. */
  quoteAmount?: string | null;
  /** USD at submission, a decimal string with at most two places. */
  usdValue?: string | null;
  /** When the path recorded it, in ms; the database's clock when absent. */
  createdAtMs?: number;
}>;

/**
 * Where the transaction stands as the path knows it now. A settled one's
 * time is the path's own record of it when it has one, else the database's
 * clock; it is never before the row's `created_at_ms`.
 */
export type TransactionProgress =
  | Readonly<{ state: "submitted"; digest: string | null }>
  | Readonly<{ state: "confirmed"; digest: string; settledAtMs?: number }>
  | Readonly<{ state: "failed"; digest: string | null; failureCode: SocialTransactionFailure; settledAtMs?: number }>;

/** One row of `social_transactions` as the helper and the list read it. */
export type TransactionRow = Readonly<{
  tx_id: string;
  account_id: string;
  kind: SocialTransactionKind;
  state: SocialTransactionState;
  digest: string | null;
  failure_code: SocialTransactionFailure | null;
  presale_id: string | null;
  coin_type: string | null;
  amount: string | null;
  quote_type: string | null;
  quote_amount: string | null;
  usd_value: string | null;
  idempotency_key: string;
  created_at_ms: string;
  settled_at_ms: string | null;
}>;

export type TransactionLogOutcome = "recorded" | "repeat" | "advanced";

/** The key's stored row says otherwise: `facts` (kind, sale, coins, amounts, id), `digest`, or `outcome`. */
export class TransactionLogConflict extends Error {
  readonly reason: "facts" | "digest" | "outcome";
  constructor(reason: "facts" | "digest" | "outcome") {
    super(`The transaction log already holds this key with another ${reason}.`);
    this.name = "TransactionLogConflict";
    this.reason = reason;
  }
}

export const TRANSACTION_COLUMNS = `tx_id::text AS tx_id, account_id::text AS account_id, kind, state, digest, failure_code, presale_id,
  coin_type, amount::text AS amount, quote_type, quote_amount::text AS quote_amount, usd_value::text AS usd_value,
  idempotency_key, created_at_ms::text AS created_at_ms, settled_at_ms::text AS settled_at_ms`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATOMS = /^(0|[1-9][0-9]{0,19})$/;
const USD = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$/;

/** A programming error in a writer, refused before anything is written (never a user-facing code). */
function assertEntry(entry: TransactionEntry, progress: TransactionProgress): void {
  const problems: string[] = [];
  const fields = z.object({
    kind: z.enum(SOCIAL_TRANSACTION_KINDS), accountId: z.string().regex(UUID), txId: z.string().regex(UUID).optional(),
    idempotencyKey: z.string().min(1).max(200), amount: z.string().regex(ATOMS).nullish(),
    quoteAmount: z.string().regex(ATOMS).nullish(), usdValue: z.string().regex(USD).nullish(),
  }).safeParse(entry);
  if (!fields.success) problems.push(...fields.error.issues.map((issue) => String(issue.path[0])));
  if (progress.state === "failed" && !isSocialTransactionFailure(progress.failureCode)) problems.push("failureCode");
  if (problems.length > 0) throw new TypeError(`Invalid transaction log entry: ${problems.join(", ")}.`);
}

const fact = (value: string | null | undefined) => value ?? null;

/** Whether the stored row is the transaction `entry` describes. */
function sameFacts(row: TransactionRow, entry: TransactionEntry): boolean {
  return (
    row.kind === entry.kind &&
    (entry.txId === undefined || row.tx_id === entry.txId) &&
    row.presale_id === fact(entry.presaleId) &&
    row.coin_type === fact(entry.coinType) &&
    row.amount === fact(entry.amount) &&
    row.quote_type === fact(entry.quoteType) &&
    row.quote_amount === fact(entry.quoteAmount)
  );
}

function settledAt(progress: TransactionProgress): number | null {
  return progress.state === "submitted" ? null : (progress.settledAtMs ?? null);
}

/** Now in ms on the database's clock. */
const NOW_MS = "(extract(epoch FROM now()) * 1000)::bigint";

function failureOf(progress: TransactionProgress): SocialTransactionFailure | null {
  return progress.state === "failed" ? progress.failureCode : null;
}

/**
 * Logs one transaction for an account, or moves its logged row forward
 * (see the module comment). Runs inside the caller's transaction; the
 * caller's write and this row commit together.
 */
export async function logTransaction(
  social: ModuleTransaction<"social">,
  entry: TransactionEntry,
  progress: TransactionProgress = { state: "submitted", digest: null },
): Promise<Readonly<{ row: TransactionRow; outcome: TransactionLogOutcome }>> {
  assertEntry(entry, progress);
  const inserted = await social.write<TransactionRow>(
    "social_transactions",
    `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, coin_type, amount, quote_type, quote_amount,
       usd_value, idempotency_key, created_at_ms, settled_at_ms, failure_code)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric, $11::numeric, $12,
       COALESCE($13::bigint, ${NOW_MS}),
       CASE WHEN $4 = 'submitted' THEN NULL ELSE GREATEST(COALESCE($14::bigint, ${NOW_MS}), COALESCE($13::bigint, ${NOW_MS})) END,
       $15)
     ON CONFLICT (account_id, idempotency_key) DO NOTHING
     RETURNING ${TRANSACTION_COLUMNS}`,
    [
      entry.txId ?? randomUUID(),
      entry.accountId,
      entry.kind,
      progress.state,
      progress.digest,
      fact(entry.presaleId),
      fact(entry.coinType),
      fact(entry.amount),
      fact(entry.quoteType),
      fact(entry.quoteAmount),
      fact(entry.usdValue),
      entry.idempotencyKey,
      entry.createdAtMs ?? null,
      settledAt(progress),
      failureOf(progress),
    ],
  );
  if (inserted.rows[0]) {
    recordMetric("social.transaction_log", { kind: entry.kind, outcome: "recorded", state: progress.state });
    return { row: inserted.rows[0], outcome: "recorded" };
  }

  const { rows } = await social.read<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM social_transactions WHERE account_id = $1::uuid AND idempotency_key = $2 FOR UPDATE`,
    [entry.accountId, entry.idempotencyKey],
  );
  const stored = rows[0];
  if (!stored) throw new Error("The transaction log's conflicting row is gone.");
  const refuse = (reason: TransactionLogConflict["reason"]) => {
    recordMetric("social.transaction_log", { kind: entry.kind, outcome: "conflict", reason });
    return new TransactionLogConflict(reason);
  };
  if (!sameFacts(stored, entry)) throw refuse("facts");
  if (progress.digest !== null && stored.digest !== null && progress.digest !== stored.digest) throw refuse("digest");
  if (stored.state !== "submitted") {
    if (progress.state !== "submitted" && progress.state !== stored.state) throw refuse("outcome");
    return { row: stored, outcome: "repeat" };
  }
  const digest = stored.digest ?? progress.digest;
  if (progress.state === "submitted" && digest === stored.digest) return { row: stored, outcome: "repeat" };

  const advanced = await social.write<TransactionRow>(
    "social_transactions",
    `UPDATE social_transactions SET state = $2, digest = $3, failure_code = $5,
       settled_at_ms = CASE WHEN $2 = 'submitted' THEN NULL ELSE GREATEST(COALESCE($4::bigint, ${NOW_MS}), created_at_ms) END
     WHERE tx_id = $1::uuid AND state = 'submitted'
     RETURNING ${TRANSACTION_COLUMNS}`,
    [stored.tx_id, progress.state, digest, settledAt(progress), failureOf(progress)],
  );
  // The row is locked above, so it is still `submitted`.
  if (!advanced.rows[0]) throw new Error("The logged transaction moved under its lock.");
  recordMetric("social.transaction_log", { kind: entry.kind, outcome: "advanced", state: progress.state });
  return { row: advanced.rows[0], outcome: "advanced" };
}

/** How a path that did not log a row settles it: the outcome, as the chain shows it. */
export type TransactionSettlement =
  | Readonly<{ state: "confirmed"; digest: string; settledAtMs?: number }>
  | Readonly<{ state: "failed"; failureCode: SocialTransactionFailure; settledAtMs?: number }>;

/** `settleLoggedTransaction`'s one statement (by the idempotency key's unique index), for its plan. */
export const SETTLE_LOGGED_SQL = `UPDATE social_transactions SET state = $3, digest = COALESCE(digest, $4), failure_code = $5,
    settled_at_ms = GREATEST(COALESCE($6::bigint, ${NOW_MS}), created_at_ms)
  WHERE account_id = $1::uuid AND idempotency_key = $2 AND state = 'submitted'
  RETURNING kind`;

/**
 * Settles a logged row from outside the path that logged it: the social
 * worker, which sees the chain but never saw the dialog (T-026 with R3-27,
 * migration 0085 grants `blast_watcher` `SELECT, UPDATE` and nothing else).
 *
 * Only ever `submitted` → `confirmed` or `failed`, guarded in the statement,
 * so a repeat, a race with the web's own settlement and a row already settled
 * all change nothing (`unchanged`). It never inserts: a key with no row (a
 * commit registered before 0084) is left alone. A recorded digest is kept;
 * 0084's trigger refuses replacing one. The settled time is the chain's when
 * the caller has it, and never before the row was created.
 */
export async function settleLoggedTransaction(
  social: ModuleTransaction<"social">,
  key: Readonly<{ accountId: string; idempotencyKey: string }>,
  settlement: TransactionSettlement,
): Promise<"settled" | "unchanged"> {
  if (settlement.state === "failed" && !isSocialTransactionFailure(settlement.failureCode)) {
    throw new TypeError("Invalid transaction settlement: failureCode.");
  }
  const settled = await social.write<{ kind: SocialTransactionKind }>(
    "social_transactions",
    SETTLE_LOGGED_SQL,
    [
      key.accountId,
      key.idempotencyKey,
      settlement.state,
      settlement.state === "confirmed" ? settlement.digest : null,
      settlement.state === "failed" ? settlement.failureCode : null,
      settlement.settledAtMs ?? null,
    ],
  );
  const row = settled.rows[0];
  if (!row) return "unchanged";
  recordMetric("social.transaction_log", { kind: row.kind, outcome: "settled", state: settlement.state });
  return "settled";
}
