import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { coinWithBalance, Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import type { SocialTransfer } from "@blast/core/web/contracts/coins.ts";

import {
  executeOnFullnode,
  pollSettlement,
  requestSponsorship,
  signExactly,
  signSponsored,
  type Sent,
  type SponsoredSigner,
  type Unsigned,
} from "#web/components/social/sponsored-transaction.ts";
import type { ApiResult, SocialApiOptions } from "#web/components/social/social-api.ts";
import { putTransfer } from "./coins-client";
import { USDC_MIN_WITHDRAW_ATOMS } from "./coin-model";
import { duringWithdrawalBroadcast } from "./withdraw-attempt";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * One withdrawal from the Blast wallet (canonical UI §14.2): record it under
 * the sheet's request id, build the transfer from the wallet's own coins, have
 * it signed and executed, then record its digest so the server settles it.
 *
 * - Native USDC uses Sui's gasless balance transfer, signed and submitted
 *   directly without the gas pool, for a Privy embedded wallet and a wallet
 *   session alike.
 * - Other transfers are sponsored, from a Privy embedded wallet and a wallet
 *   session alike (owner ruling 2026-11-20, reversing OA-17): the kind goes to
 *   the presale sponsor's `withdraw` intent, the returned bytes are checked to
 *   be exactly that kind from that sender, the wallet signs exactly them, and
 *   the sponsor executes them (Blast pays the fee).
 *
 * A retry with the same request id never sends twice once a digest is known:
 * the recorded digest (or the one this sheet already got) is settled instead.
 */

/** The Blast wallet's signer, on Blast's gas: it signs only, and the flow submits. */
export type WithdrawSigner = SponsoredSigner;

export type WithdrawRequest = Readonly<{
  requestId: string;
  coinType: string;
  atoms: bigint;
  recipient: string;
}>;

export type WithdrawDependencies = Readonly<{
  api: SocialApiOptions;
  /** Mainnet, to resolve the wallet's coins while building. */
  client: ClientWithCoreApi;
  signer: WithdrawSigner;
  /** A digest an earlier attempt of this request already got (never sent twice). */
  knownDigest?: string | null;
  /** Called as soon as a digest exists, so a retry settles it instead of sending again. */
  onDigest?: (digest: string) => void;
}>;

export type WithdrawResult =
  | Readonly<{ status: "sent"; digest: string; transfer: SocialTransfer | null }>
  /** Submitted or possibly sent; retain its digest so a retry only checks settlement. */
  | Readonly<{ status: "pending"; digest: string; transfer: SocialTransfer | null }>
  | Readonly<{ status: "failed"; message: string; digest: string | null; balanceChanged?: true }>;

/** The user-facing reason for a refused call (OA-13: the design has no failure copy). */
export function refusalMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status === "error") {
    return diagnosticMessage("The withdrawal could not reach Blast. Nothing was sent. Try again.", result);
  }

  switch (result.code) {
    case "insufficient_balance":
      return diagnosticMessage("Your balance changed. Check the amount. Nothing was sent.", result);
    case "rate_limited":
    case "budget_exceeded":
      return diagnosticMessage("Too many withdrawals for now. Nothing was sent. Try again later.", result);
    case "pool_unavailable":
    case "deployment_unavailable":
    case "deployment_mismatch":
    case "service_unavailable":
    case "identity_unavailable":
      return diagnosticMessage("Withdrawals are paused for a moment. Nothing was sent. Try again soon.", result);
    case "dry_run_failed":
      return diagnosticMessage("This withdrawal would fail on Sui. Check the amount. Nothing was sent.", result);
    case "invalid_recipient":
      return diagnosticMessage("Send to an address other than your Blast wallet.", result);
    case "blast_wallet_missing":
    case "not_embedded_wallet":
      return diagnosticMessage("Your Blast wallet is not ready. Reload and try again.", result);
    case "transfer_conflict":
      return diagnosticMessage("This withdrawal changed. Close the sheet and start again.", result);
    case "unauthorized":
    case "account_required":
      return diagnosticMessage("Sign in again to withdraw.", result);
    default:
      return diagnosticMessage("The withdrawal did not go through. Nothing was sent.", result);
  }
}

/** Native USDC uses the gasless balance API; other coins use an ordinary transfer. */
export function withdrawTransaction(request: Pick<WithdrawRequest, "coinType" | "atoms" | "recipient">, sender: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  if (request.coinType === USDC_COIN_TYPE) {
    tx.setGasPrice(0);
    tx.setGasBudget(0);
    tx.setGasPayment([]);
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [USDC_COIN_TYPE],
      arguments: [tx.balance({ type: USDC_COIN_TYPE, balance: request.atoms }), tx.pure.address(request.recipient)],
    });
    return tx;
  }
  // A sponsored transaction never touches the gas coin: SUI comes from the sender's own coins.
  const coin = tx.add(coinWithBalance({ type: request.coinType, balance: request.atoms, useGasCoin: false }));
  tx.transferObjects([coin], tx.pure.address(request.recipient));
  return tx;
}

export async function runWithdraw(deps: WithdrawDependencies, request: WithdrawRequest): Promise<WithdrawResult> {
  const { signer } = deps;
  const record = { coin_type: request.coinType, amount: request.atoms.toString(), recipient: request.recipient };
  const recorded = await putTransfer(deps.api, request.requestId, deps.knownDigest ? { ...record, digest: deps.knownDigest } : record);
  if (recorded.status !== "ok") {
    return deps.knownDigest
      ? { status: "pending", digest: deps.knownDigest, transfer: null }
      : refusedWithdrawal(recorded);
  }

  // Already sent (an earlier attempt, another tab): settle it, never send again.
  const existing = recorded.body.digest ?? deps.knownDigest ?? null;
  if (existing) {
    return settledResult(await settle(deps, request, existing), existing);
  }

  if (request.coinType === USDC_COIN_TYPE && request.atoms < USDC_MIN_WITHDRAW_ATOMS) {
    return notSent(diagnosticMessage("Minimum withdrawal is 0.01 USDC. Nothing was sent.", { code: "insufficient_balance" }));
  }

  const transaction = withdrawTransaction(request, signer.address);
  return request.coinType === USDC_COIN_TYPE
    ? sendGasless(deps, request, transaction, signer)
    : sendSponsored(deps, request, transaction, signer);
}

/** Native USDC: the Blast wallet signs Sui's gasless transfer exactly and Blast submits it, no sponsor. */
async function sendGasless(deps: WithdrawDependencies, request: WithdrawRequest, transaction: Transaction, signer: SponsoredSigner): Promise<WithdrawResult> {
  let bytes: Uint8Array;
  try {
    const [{ systemState }, { chainIdentifier }] = await Promise.all([
      deps.client.core.getCurrentSystemState(),
      deps.client.core.getChainIdentifier(),
    ]);
    const epoch = BigInt(systemState.epoch);
    // Sui checks expiry during simulation when the transfer draws only from an address balance.
    transaction.setExpiration({
      ValidDuring: {
        minEpoch: String(epoch),
        maxEpoch: String(epoch + 1n),
        minTimestamp: null,
        maxTimestamp: null,
        chain: chainIdentifier,
        nonce: crypto.getRandomValues(new Uint32Array(1))[0]!,
      },
    });
    bytes = await transaction.build({ client: deps.client });
  } catch (error) {
    return preparationFailed(error);
  }

  const signed = await signExactly(signer, bytes, deps.api.signal);
  if (signed.status === "unsigned") {
    return notSent(signed.reason === "mismatch" ? walletUnsignedMessage(signed) : CANCELLED);
  }
  if (deps.api.signal?.aborted) return notSent(CANCELLED);

  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const sent = await duringWithdrawalBroadcast(() => {
    deps.onDigest?.(digest);
    return executeOnFullnode(deps.client, bytes, signed.signature);
  });
  return settleSent(deps, request, sent, digest, bytes);
}

/** Any other coin, on Blast's gas: the sponsor's `withdraw` intent pays the fee. */
async function sendSponsored(deps: WithdrawDependencies, request: WithdrawRequest, transaction: Transaction, signer: SponsoredSigner): Promise<WithdrawResult> {
  let kind: Uint8Array;
  try {
    kind = await transaction.build({ client: deps.client, onlyTransactionKind: true });
  } catch (error) {
    return preparationFailed(error);
  }

  const sponsorship = await requestSponsorship(deps.api, { sender: signer.address, transaction_kind_bytes: toBase64(kind), intent: "withdraw" });
  if (sponsorship.status !== "ok") {
    return refusedWithdrawal(sponsorship);
  }

  const signed = await signSponsored({ api: deps.api, sponsorship: sponsorship.body, kind, signer, signal: deps.api.signal });
  if (signed.status === "unsigned") {
    return notSent(signed.reason === "mismatch" && signed.error === undefined
      ? diagnosticMessage("Blast returned a different transaction. Nothing was signed.", { code: "invalid_response" })
      : signed.reason === "mismatch" ? walletUnsignedMessage(signed) : CANCELLED);
  }
  if (deps.api.signal?.aborted) return notSent(CANCELLED);

  const sent = await duringWithdrawalBroadcast(async () => {
    const answer = await signed.send();
    // A lost reply may follow a send. Keep that digest and settle these exact bytes.
    if (answer.status !== "refused") deps.onDigest?.(signed.digest);
    return answer;
  });
  if (sent.status === "refused") {
    return refusedWithdrawal(sent.refusal);
  }

  return settleSent(deps, request, sent, signed.digest, signed.bytes);
}

/** After a send: a failure on chain is reported at once; anything else is settled by its digest. */
async function settleSent(deps: WithdrawDependencies, request: WithdrawRequest, sent: Sent, digest: string, bytes: Uint8Array): Promise<WithdrawResult> {
  if (sent.status === "executed" && sent.executed === "failure") {
    await settle(deps, request, digest, bytes);
    return { status: "failed", message: FAILED_ON_SUI, digest };
  }

  return settledResult(await settle(deps, request, digest, bytes), digest);
}

function settle(deps: WithdrawDependencies, request: WithdrawRequest, digest: string, bytes?: Uint8Array): Promise<SocialTransfer | null> {
  const body = { coin_type: request.coinType, amount: request.atoms.toString(), recipient: request.recipient, digest, ...(bytes ? { transaction_bytes: toBase64(bytes) } : {}) };
  return pollSettlement(() => putTransfer(deps.api, request.requestId, body), (transfer) => transfer.status === "submitted");
}

function settledResult(transfer: SocialTransfer | null, digest: string): WithdrawResult {
  if (transfer?.status === "failed") {
    const message = transfer.failure === "execution_failed" ? FAILED_ON_SUI : diagnosticMessage("That transaction is not this withdrawal.", { code: "execution_failed" });
    return { status: "failed", message, digest };
  }

  return { status: transfer?.status === "confirmed" ? "sent" : "pending", digest, transfer };
}

function walletUnsignedMessage(unsigned: Unsigned): string {
  switch (unsigned.reason) {
    case "mismatch":
      return diagnosticMessage("Your wallet returned a different transaction. Nothing was submitted.", { code: "invalid_response" });
    case "rejected":
      return publicErrorMessage(unsigned.error, "Withdrawal cancelled. Nothing was sent.", "wallet_rejected");
    case "sign_failed":
      return publicErrorMessage(unsigned.error, "Your wallet could not sign. Reconnect it and try again. Nothing was sent.", "sign_failed");
  }
}

function notSent(message: string, balanceChanged = false): WithdrawResult {
  return { status: "failed", message, digest: null, ...(balanceChanged && { balanceChanged: true }) };
}

function refusedWithdrawal(result: Exclude<ApiResult<unknown>, { status: "ok" }>) {
  return notSent(refusalMessage(result), result.status === "refused" && result.code === "insufficient_balance");
}

function preparationFailed(error: unknown): WithdrawResult {
  // The current Sui SDK reports these two coin/address balance failures as ordinary Errors.
  if (error instanceof Error && /^Insufficient (?:balance of |address balance for )/.test(error.message)) {
    return notSent(BALANCE_CHANGED, true);
  }
  return notSent(diagnosticMessage("Could not prepare this withdrawal. Check the amount and try again. Nothing was sent.", { code: "withdraw_build_failed" }));
}

const BALANCE_CHANGED = diagnosticMessage("Your balance changed. Check the amount. Nothing was sent.", { code: "insufficient_balance" });
const CANCELLED = diagnosticMessage("Withdrawal cancelled. Nothing was sent.", { code: "wallet_rejected" });
const FAILED_ON_SUI = diagnosticMessage("The withdrawal failed on Sui. Your coins did not move.", { code: "execution_failed" });
