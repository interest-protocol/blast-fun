import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type {
  SocialTransfer,
  SocialTransferFailure,
  SocialTransferFee,
  SocialTransferStatus,
} from "@blast/core/modules/social/contracts/coins.ts";
import { atomsToUsd, PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { logTransaction, type TransactionProgress } from "@blast/core/modules/social/transactions/log.ts";

/** One withdrawal as `social_coin_transfers` (migration 0075) holds it. */
export type TransferRow = Readonly<{
  request_id: string;
  account_id: string;
  sender: string;
  recipient: string;
  coin_type: string;
  amount: string;
  fee: SocialTransferFee;
  status: SocialTransferStatus;
  digest: string | null;
  failure: SocialTransferFailure | null;
  created_ms: string;
  settled_ms: string | null;
}>;

/** What a withdrawal is: the same request id must always name the same one. */
export type TransferIntent = Readonly<{
  sender: string;
  recipient: string;
  coinType: string;
  amount: string;
  fee: SocialTransferFee;
}>;

const COLUMNS = `request_id::text AS request_id, account_id::text AS account_id, sender, recipient, coin_type,
  amount::text AS amount, fee, status, digest, failure,
  (extract(epoch FROM created_at) * 1000)::bigint::text AS created_ms,
  (extract(epoch FROM settled_at) * 1000)::bigint::text AS settled_ms`;

export function transferBody(row: TransferRow): SocialTransfer {
  return {
    request_id: row.request_id,
    coin_type: row.coin_type,
    amount: row.amount,
    recipient: row.recipient,
    fee: row.fee,
    status: row.status,
    digest: row.digest,
    failure: row.failure,
    created_at_ms: Number(row.created_ms),
    settled_at_ms: row.settled_ms === null ? null : Number(row.settled_ms),
  };
}

/** Whether a stored row is the withdrawal `intent` describes (the client may resend it any number of times). */
export function sameTransfer(row: TransferRow, intent: TransferIntent): boolean {
  return (
    row.sender === intent.sender &&
    row.recipient === intent.recipient &&
    row.coin_type === intent.coinType &&
    row.amount === intent.amount &&
    row.fee === intent.fee
  );
}

/** The row under the caller's lock, or null. */
export async function lockTransfer(social: ModuleTransaction<"social">, requestId: string): Promise<TransferRow | null> {
  const { rows } = await social.read<TransferRow>(
    `SELECT ${COLUMNS} FROM social_coin_transfers WHERE request_id = $1::uuid FOR UPDATE`,
    [requestId],
  );
  return rows[0] ?? null;
}

export async function readTransfer(db: ReadableDatabase, requestId: string): Promise<TransferRow | null> {
  const { rows } = await db.read<TransferRow>(`SELECT ${COLUMNS} FROM social_coin_transfers WHERE request_id = $1::uuid`, [requestId]);
  return rows[0] ?? null;
}

/**
 * Records a new withdrawal, `pending`, or `submitted` when its digest is
 * already known; null when the request id is already recorded (the caller
 * then reads it under its lock).
 */
export async function insertTransfer(
  social: ModuleTransaction<"social">,
  input: Readonly<{ requestId: string; accountId: string; intent: TransferIntent; digest: string | null }>,
): Promise<TransferRow | null> {
  const { intent } = input;
  const { rows } = await social.write<TransferRow>(
    "social_coin_transfers",
    `INSERT INTO social_coin_transfers (request_id, account_id, sender, recipient, coin_type, amount, fee, status, digest)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7, $8, $9)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.requestId, input.accountId, intent.sender, intent.recipient, intent.coinType, intent.amount, intent.fee, input.digest ? "submitted" : "pending", input.digest],
  );
  return rows[0] ?? null;
}

/** Adds the digest to a `pending` withdrawal (`submitted`). */
export async function attachDigest(social: ModuleTransaction<"social">, requestId: string, digest: string): Promise<TransferRow> {
  const { rows } = await social.write<TransferRow>(
    "social_coin_transfers",
    `UPDATE social_coin_transfers SET digest = $2, status = 'submitted', updated_at = now()
     WHERE request_id = $1::uuid AND status = 'pending'
     RETURNING ${COLUMNS}`,
    [requestId, digest],
  );
  if (!rows[0]) throw new Error("The withdrawal was not pending.");
  return rows[0];
}

/** Settles a `submitted` withdrawal once; null when another request settled it first. */
export async function settleTransfer(
  social: ModuleTransaction<"social">,
  requestId: string,
  outcome: Readonly<{ status: "confirmed" } | { status: "failed"; failure: SocialTransferFailure }>,
): Promise<TransferRow | null> {
  const { rows } = await social.write<TransferRow>(
    "social_coin_transfers",
    `UPDATE social_coin_transfers SET status = $2, failure = $3, settled_at = now(), updated_at = now()
     WHERE request_id = $1::uuid AND status = 'submitted'
     RETURNING ${COLUMNS}`,
    [requestId, outcome.status, outcome.status === "failed" ? outcome.failure : null],
  );
  return rows[0] ?? null;
}

/** Where a withdrawal stands, in the transaction log's terms: recorded or waiting is `submitted`. */
function transferProgress(row: TransferRow): TransactionProgress {
  if (row.status === "confirmed" && row.digest !== null) return { state: "confirmed", digest: row.digest, settledAtMs: Number(row.settled_ms) };
  if (row.status === "failed") return { state: "failed", digest: row.digest, failureCode: row.failure ?? "execution_failed", settledAtMs: Number(row.settled_ms) };
  return { state: "submitted", digest: row.digest };
}

/**
 * Logs the withdrawal in `social_transactions` (R3-27) as `row` now stands,
 * in the caller's transaction, beside its `social_coin_transfers` record
 * (which stays the authority for the withdrawal's own state). The log row's
 * id is the request id and its key `withdraw:<request id>`, so a repeat
 * logs once and a later call only adds the digest, then the outcome; a
 * withdrawal recorded before the log existed is logged by its next call.
 */
export async function logTransfer(social: ModuleTransaction<"social">, row: TransferRow): Promise<void> {
  await logTransaction(
    social,
    {
      accountId: row.account_id,
      kind: "withdraw",
      idempotencyKey: `withdraw:${row.request_id}`,
      txId: row.request_id,
      coinType: row.coin_type,
      amount: row.amount,
      // USDC is a dollar; any other coin's value at submission is not known here.
      usdValue: row.coin_type === PORTFOLIO_COIN_TYPES.usdc ? atomsToUsd(row.amount, 6, "1") : null,
      createdAtMs: Number(row.created_ms),
    },
    transferProgress(row),
  );
}

/** What the fullnode says about one executed transaction, as the settlement reads it. */
export type ExecutedTransfer = Readonly<{
  success: boolean;
  sender: string;
  balanceChanges: readonly Readonly<{ address: string; coinType: string; amount: string }>[];
}>;

/**
 * The verdict on a recorded withdrawal from its executed transaction:
 * `confirmed` when it succeeded, was sent by the Blast wallet, and moved
 * exactly `amount` of the coin to the recipient; `execution_failed` when it
 * aborted; `mismatch` when it is some other transaction (another sender,
 * recipient, coin or amount).
 */
export function transferVerdict(
  row: Pick<TransferRow, "sender" | "recipient" | "coin_type" | "amount">,
  executed: ExecutedTransfer,
): Readonly<{ status: "confirmed" } | { status: "failed"; failure: SocialTransferFailure }> {
  if (normalizeSuiAddress(executed.sender) !== row.sender) return { status: "failed", failure: "mismatch" };
  if (!executed.success) return { status: "failed", failure: "execution_failed" };
  const received = executed.balanceChanges
    .filter((change) => {
      try {
        return normalizeSuiAddress(change.address) === row.recipient && normalizeStructTag(change.coinType) === row.coin_type;
      } catch {
        return false;
      }
    })
    .reduce((sum, change) => sum + BigInt(change.amount), 0n);
  return received === BigInt(row.amount) ? { status: "confirmed" } : { status: "failed", failure: "mismatch" };
}
