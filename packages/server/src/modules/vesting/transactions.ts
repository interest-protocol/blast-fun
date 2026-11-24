import { isDeepStrictEqual } from "node:util";

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { ObjectError, TransactionError } from "@mysten/sui/client";
import {
  VestingTransactions,
  decodeVestingEvent,
} from "@interest-protocol/blast-util-sdk/vesting";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext } from "@blast/server/modules/social/route-kit/route.ts";
import {
  logTransaction,
  type TransactionEntry,
  type TransactionRow,
} from "@blast/core/modules/social/transactions/log.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { prepareVestingTransaction } from "@blast/server/modules/vesting/prepare-transaction.ts";
import { createVestingTransaction } from "@blast/server/modules/vesting/create-transaction.ts";
import {
  VESTING_DEPLOYMENT,
  VESTING_PACKAGE,
  type VestingIntent,
  type VestingAttempt,
} from "@blast/core/modules/vesting/model.ts";
import { vestingPreparationReason } from "@blast/core/modules/vesting/preparation-error.ts";
import { cancellationCapForWallet } from "@blast/server/modules/vesting/cancellation-authority.ts";
import { readVesting, vestingChain, vestingClient } from "@blast/server/modules/vesting/read.ts";

const builders = new VestingTransactions(VESTING_DEPLOYMENT);
type Stored = {
  request_id: string;
  account_id: string;
  sender: string;
  intent: VestingIntent;
  transaction_bytes: string;
  digest: string;
  gas_budget: string;
  expires_at_ms: string;
  schedule_id: string | null;
  sponsor_reservation_id: string | null;
};
const ENTRY_SQL = `SELECT * FROM social_vesting_attempts WHERE request_id=$1 AND account_id=$2`;
function entry(row: Stored): TransactionEntry {
  return {
    accountId: row.account_id,
    txId: row.request_id,
    kind: `vesting_${row.intent.action}`,
    idempotencyKey: `utility_vesting:${row.request_id}`,
    coinType: row.intent.action === "create" ? row.intent.coinType : null,
    amount: row.intent.action === "create" ? row.intent.total : null,
  };
}
function answer(row: Stored, state: TransactionRow["state"]): VestingAttempt {
  return {
    request_id: row.request_id,
    action: row.intent.action,
    state,
    digest: row.digest,
    transaction_bytes: row.transaction_bytes,
    schedule_id: row.schedule_id,
    gas_budget: row.gas_budget,
    expires_at_ms: Number(row.expires_at_ms),
    sponsor_reservation_id: row.sponsor_reservation_id,
  };
}
export async function canCancel(
  scheduleId: string,
  sender: string,
): Promise<string | null> {
  const { schedule } = await readVesting(scheduleId);
  return cancellationCapForWallet(
    schedule,
    sender,
    VESTING_PACKAGE,
    async (objectId) => {
      const { object } = await vestingChain().core
        .getObject({
          objectId,
          include: { content: true },
        })
        .catch((error: unknown) => {
          if (
            error instanceof ObjectError &&
            ["notFound", "deleted"].includes(error.reason)
          )
            return { object: null };
          throw error;
        });
      return object;
    },
  );
}
async function buildTransaction(
  intent: VestingIntent,
  sender: string,
): Promise<Transaction> {
  const now = await vestingClient().getCurrentTimestampMs();
  if (intent.action === "create") {
    return createVestingTransaction(intent, now);
  }
  const state = await vestingClient().getVesting(intent.scheduleId);
  if (intent.action === "cancel") {
    const cap = await canCancel(intent.scheduleId, sender);
    if (!cap) throw new SocialRouteError("invalid_request");
    return builders.cancel({ ...state, cancelCapId: cap });
  }
  if (intent.action === "close") {
    if (state.refundRecipient !== null || state.balance !== 0n)
      throw new SocialRouteError("invalid_request");
    return builders.closeIrrevocable(state);
  }
  // The contract is permissionless; product actions allow the fixed beneficiary only.
  if (state.beneficiary !== sender)
    throw new SocialRouteError("invalid_request");
  if ((await vestingClient().preview(intent.scheduleId, now)).releasable === 0n)
    throw new SocialRouteError("invalid_request");
  return builders.claim(state);
}
export async function prepareVesting(
  context: SocialRequestContext,
  requestId: string,
  intent: VestingIntent,
): Promise<VestingAttempt> {
  const account = context.account!,
    caller = context.caller!;
  const sender = await blastWalletOf(caller);
  if (!sender) throw new SocialRouteError("invalid_request");
  const existing = await context.transaction(
    async (db) =>
      (await db.read<Stored>(ENTRY_SQL, [requestId, account.account_id]))
        .rows[0],
  );
  if (existing) {
    if (!isDeepStrictEqual(existing.intent, intent))
      throw new SocialRouteError("claim_conflict");
    return settleVesting(context, existing);
  }
  let transaction: Transaction;
  try {
    transaction = await buildTransaction(intent, sender);
  } catch (error) {
    if (error instanceof SocialRouteError) throw error;
    if (error instanceof RangeError || error instanceof TypeError)
      throw new SocialRouteError("invalid_request");
    throw error;
  }
  const { bytes, reservationId, expiresAt } = await prepareTransaction(
    context,
    requestId,
    intent,
    sender,
    transaction,
  );
  const digest = await Transaction.from(bytes).getDigest();
  const row: Stored = {
    request_id: requestId,
    account_id: account.account_id,
    sender,
    intent,
    transaction_bytes: toBase64(bytes),
    digest,
    gas_budget: String(Transaction.from(bytes).getData().gasData.budget!),
    expires_at_ms: String(expiresAt),
    sponsor_reservation_id: reservationId,
    schedule_id: intent.action === "create" ? null : intent.scheduleId,
  };
  return context.transaction(async (db) => {
    await logTransaction(db, entry(row), { state: "submitted", digest });
    const inserted = await db.write<Stored>(
      "social_vesting_attempts",
      `INSERT INTO social_vesting_attempts (request_id,account_id,sender,intent,transaction_bytes,digest,gas_budget,expires_at_ms,schedule_id,sponsor_reservation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_id) DO NOTHING RETURNING *`,
      [
        requestId,
        row.account_id,
        sender,
        intent,
        row.transaction_bytes,
        digest,
        row.gas_budget,
        row.expires_at_ms,
        row.schedule_id,
        row.sponsor_reservation_id,
      ],
    );
    const stored =
      inserted.rows[0] ??
      (await db.read<Stored>(ENTRY_SQL, [requestId, row.account_id])).rows[0];
    if (!stored || stored.digest !== digest)
      throw new SocialRouteError("claim_conflict");
    return answer(stored, "submitted");
  });
}
async function prepareTransaction(
  context: SocialRequestContext,
  requestId: string,
  intent: VestingIntent,
  sender: string,
  transaction: Transaction,
) {
  const caller = context.caller!;
  transaction.setSender(sender);
  try {
    // The sponsor dry-runs the kind before it reserves gas, so no second simulation runs here.
    return await prepareVestingTransaction(
      transaction,
      {
        sender,
        caller,
        ip: context.client.rateKey,
        signal: context.request.signal,
      },
      vestingChain(),
      {
        sponsor: (request) => sponsorService().sponsor(request),
      },
    );
  } catch (error) {
    if (error instanceof PresaleRouteError) {
      const limited =
        error.code === "budget_exceeded" || error.code === "rate_limited";
      throw new SocialRouteError(
        limited ? "rate_limited" : "service_unavailable",
        {
          extra: { reasons: ["sponsorship_unavailable"] },
          retryAfterSeconds: error.retryAfterSeconds ?? undefined,
        },
      );
    }
    const reason = vestingPreparationReason(error);
    // Deliberately omit raw RPC text, headers, addresses and transaction bytes.
    console.warn(
      JSON.stringify({
        event: "vesting_preparation_failed",
        requestId,
        stage: "build",
        reason,
        network: "mainnet",
        action: intent.action,
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    throw new SocialRouteError("service_unavailable", {
      extra: { reasons: [reason] },
    });
  }
}

export async function settleVesting(
  context: SocialRequestContext,
  stored: Stored,
): Promise<VestingAttempt> {
  const result = await vestingChain().core
    .getTransaction({
      digest: stored.digest,
      include: { events: true, transaction: true },
    })
    .catch((error) => {
      if (error instanceof TransactionError && error.reason === "notFound")
        return null;
      throw error;
    });
  if (result === null) {
    const current = await context.transaction(
      async (db) =>
        (
          await db.read<{ state: TransactionRow["state"] }>(
            `SELECT state FROM social_transactions WHERE tx_id=$1`,
            [stored.request_id],
          )
        ).rows[0],
    );
    return answer(stored, current?.state ?? "submitted");
  }
  const executed = result.Transaction ?? result.FailedTransaction;
  if (
    normalizeSuiAddress(executed.transaction!.sender!) !== stored.sender ||
    executed.digest !==
      (await Transaction.from(fromBase64(stored.transaction_bytes)).getDigest())
  )
    throw new SocialRouteError("claim_conflict");
  let scheduleId = stored.schedule_id;
  if (executed.status.success) {
    const events = (executed.events ?? [])
      .filter((event) => event.packageId === VESTING_PACKAGE)
      .map((event, eventIndex) =>
        decodeVestingEvent(
          {
            ...event,
            transactionDigest: stored.digest,
            checkpoint: executed.checkpoint ?? "0",
            eventIndex,
          },
          VESTING_DEPLOYMENT,
        ),
      );
    const expected =
      stored.intent.action === "create"
        ? "VestingCreated"
        : stored.intent.action === "claim"
          ? "VestingClaimed"
          : stored.intent.action === "cancel"
            ? "VestingCanceled"
            : "VestingClosed";
    const event = events.find(
      (event) =>
        event.name === expected &&
        (scheduleId === null || event.payload.vesting_id === scheduleId),
    );
    if (!event) throw new SocialRouteError("claim_conflict");
    scheduleId = event.payload.vesting_id;
  }
  return context.transaction(async (db) => {
    const current = (
      await db.read<TransactionRow>(
        `SELECT * FROM social_transactions WHERE tx_id=$1 FOR UPDATE`,
        [stored.request_id],
      )
    ).rows[0]!;
    if (current.state === "submitted")
      await logTransaction(
        db,
        entry(stored),
        executed.status.success
          ? {
              digest: stored.digest,
              state: "confirmed",
              settledAtMs: Date.now(),
            }
          : {
              digest: stored.digest,
              state: "failed",
              failureCode: "execution_failed",
              settledAtMs: Date.now(),
            },
      );
    if (scheduleId)
      await db.write(
        "social_vesting_attempts",
        `UPDATE social_vesting_attempts SET schedule_id=$2 WHERE request_id=$1 AND schedule_id IS NULL`,
        [stored.request_id, scheduleId],
      );
    return answer(
      { ...stored, schedule_id: scheduleId },
      executed.status.success ? "confirmed" : "failed",
    );
  });
}
export async function refreshVesting(
  context: SocialRequestContext,
  requestId: string,
): Promise<VestingAttempt> {
  const stored = await context.transaction(
    async (db) =>
      (
        await db.read<Stored>(ENTRY_SQL, [
          requestId,
          context.account!.account_id,
        ])
      ).rows[0],
  );
  if (!stored) throw new SocialRouteError("not_found");
  return settleVesting(context, stored);
}

