import { diagnosticMessage } from "#web/lib/errors.ts";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import {
  commitOffLine,
  type CommitBlocker,
  type SocialCommitAllowlist,
  type SocialCommitPayCoin,
} from "@blast/core/web/contracts/commit.ts";
import type { SocialIntentWhyResult } from "@blast/core/web/contracts/intents.ts";

import { readSponsoredBytes } from "#web/lib/sui-signing.ts";
import {
  requestSponsorship,
  sendSponsored,
  signExactly,
  type SponsoredSigner,
  type TransactionSigner,
  type Unsigned,
} from "#web/components/social/sponsored-transaction.ts";
import type { ApiResult, SocialApiOptions } from "#web/components/social/social-api.ts";
import { registerIntentWithin, requestCommitBuild, type IntentRequest } from "./commit-client";

/**
 * One blast (FEATURE-MAP §4's "Done", R3's shared `commitTo`): have the
 * server build the commit, get the digest, register the intent, sign,
 * execute.
 *
 * **The server builds; the browser signs.** The commit is built against the
 * presale deployment (`PRESALE_DEPLOYMENT_MANIFEST`), a server environment
 * variable no browser bundle carries, so the browser asks
 * `POST /api/social/me/commits` for it — the SDK's commit for the Blast
 * wallet, as a transaction kind with the wallet's own coins — exactly as the
 * claim asks its route (R3-63). Nothing in the browser reads the deployment.
 *
 * The order is T-024's, and it is the whole point of the ticket: the social
 * layer learns the digest, the why and the post it came through **while the
 * transaction is still in the browser's hands**, so the worker can credit the
 * post the moment the indexer sees it. Registration is bounded at
 * `INTENT_REGISTER_TIMEOUT_MS` and **can never stop the commit** (AC-096):
 * a slow, broken or refusing social layer costs an attribution, never money.
 *
 * - **Sponsored** (a Privy embedded wallet or a wallet session, owner ruling
 *   2026-11-20 reversing OA-17, so Blast pays the fee): the server's
 *   transaction *kind* goes to the sponsor (a swap-and-commit comes back
 *   already sponsored by the commit route), the sponsored bytes are checked
 *   to be exactly that kind from that sender, the digest is taken from those
 *   bytes, then register, sign (a wallet must sign exactly them), execute
 *   through the sponsor.
 *
 * The flow runs the shared pipeline's steps (`signExactly`, then
 * `sendSponsored`) itself rather than `signSponsored`: a commit registers
 * before it is signed.
 *
 * Nothing is built, sponsored or signed before this runs, and this runs only
 * from the primary button's own press (AC-092).
 */

/**
 * A Blast wallet signer, either arm. A commit takes only the sponsored one
 * (`CommitDependencies.signer`); the wallet-pays arm is a trade's past the
 * day's cap (`walletCommitSigner`).
 */
export type CommitSigner = TransactionSigner;

export type CommitPhase = "preparing" | "signing" | "executing";

export type CommitRequest = Readonly<{
  presaleId: string;
  /**
   * What to commit, for the server to build (`POST /api/social/me/commits`):
   * the coin it is paid in, the commitment in the sale's quote-coin atoms
   * and, for an allowlisted sale, the Blast wallet's leaf.
   */
  order: Readonly<{ payWith: SocialCommitPayCoin; amount: string; allowlist?: SocialCommitAllowlist | null; swapQuoteId?: string }>;
  /** The feed item the viewer acted through, when there is one. */
  sourceEntryId?: string | null;
  /** The checkout why, already trimmed; empty or null means none. */
  why?: string | null;
  /**
   * The commitment's dollar value at submission, for the account's
   * transaction log (R3-27), which the registration writes. Its coin and
   * atoms are the built commit's own.
   */
  usdValue?: string | null;
}>;

export type CommitDependencies = Readonly<{
  api: SocialApiOptions;
  /** On Blast's gas: a wallet session comes through `sponsoredWalletSigner`. */
  signer: SponsoredSigner;
  /** Why blasting is off. A non-empty list refuses before anything is built. */
  blockers?: readonly CommitBlocker[];
  /** Reported as the flow moves, so the button can say what is happening. */
  onPhase?: (phase: CommitPhase) => void;
  /** Called with the digest the moment it exists, before the intent and the execute. */
  onDigest?: (digest: string) => void;
}>;

export type CommitResult =
  | Readonly<{ status: "sent"; digest: string; amount: string; why: SocialIntentWhyResult | null; registered: boolean }>
  | Readonly<{ status: "pending"; digest: string; message: string }>
  | Readonly<{ status: "blocked"; reasons: readonly CommitBlocker[] }>
  | Readonly<{ status: "refused"; message: string }>
  | Readonly<{ status: "failed"; message: string; digest: string | null; code?: "insufficient_balance" }>;

/** The Blast wallet the commit would come from is not the one signing (or not there yet). */
export const COMMIT_WALLET_NOT_READY = "Your Blast wallet is not ready. Reload and try again.";

/**
 * The user-facing reason for a refused call. Every line says what happened to
 * the money, because that is the only thing the reader needs: the reference's
 * own `commitErrorText` words where it has them, and the withdraw sheet's
 * house style (OA-13) where it does not.
 */
export function commitRefusalMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status === "error") return diagnosticMessage("The blast could not reach Blast. Nothing was sent. Try again.", result);
  switch (result.code) {
    case "rate_limited":
    case "budget_exceeded":
      return diagnosticMessage("Too many blasts for now. Nothing was sent. Try again later.", result);
    case "pool_unavailable":
    case "deployment_unavailable":
    case "deployment_mismatch":
    case "service_unavailable":
    case "identity_unavailable":
      return diagnosticMessage("Blasting is paused for a moment. Nothing was sent. Try again soon.", result);
    case "dry_run_failed":
      return diagnosticMessage("This blast would fail on Sui. Check the amount. Nothing was sent.", result);
    case "not_eligible":
      return diagnosticMessage("You’re not on this sale’s allowlist. Nothing was sent.", result);
    case "blast_wallet_missing":
    case "not_embedded_wallet":
      return diagnosticMessage(COMMIT_WALLET_NOT_READY, result);
    case "unauthorized":
    case "account_required":
      return diagnosticMessage("Sign in again to blast.", result);
    default:
      return diagnosticMessage("That didn’t go through. Nothing was sent.", result);
  }
}

/** The coins the commit counts on are not there (any more): the server's build could not cover it. */
export const COMMIT_BALANCE_CHANGED = "Your balance changed. Check the amount. Nothing was sent.";
export const COMMIT_SALE_NOT_ON_SUI = "This sale is not open on Sui. Nothing was sent.";
/** The deployment's node did not answer while the commit was being built. */
export const COMMIT_SUI_UNREACHABLE = "Sui could not be reached. Nothing was sent.";

/**
 * The words for a build the route refused (`POST /api/social/me/commits`).
 * Its own refusals keep the sentences the browser said when it built the
 * commit itself — the balance, a sale not on Sui, Sui unreachable — and
 * blasting off says the dialog's own line (`commitOffLine`), so a server
 * with no deployment is a named refusal on screen, never a crash. Every other
 * answer is `commitRefusalMessage`'s.
 *
 * `commit_unavailable` names its blockers in its body, which the session
 * helper does not pass on. A paid-in-another-coin commit that the route cannot
 * route or sponsor answers `swap_unavailable`; otherwise it is the deployment.
 */
export function commitBuildRefusalMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status === "refused") {
    switch (result.code) {
      case "commit_unavailable":
        if (result.reasons?.includes("swap_unavailable")) return diagnosticMessage(commitOffLine(["swap_unavailable"]), result);
        return diagnosticMessage(commitOffLine(["presale_not_deployed"]), result);
      case "insufficient_balance":
        return diagnosticMessage(COMMIT_BALANCE_CHANGED, result);
      case "not_found":
        return diagnosticMessage(COMMIT_SALE_NOT_ON_SUI, result);
      case "service_unavailable":
        return diagnosticMessage(COMMIT_SUI_UNREACHABLE, result);
    }
  }
  return commitRefusalMessage(result);
}

export const COMMIT_SIGNATURE_REFUSED = "You didn’t confirm it. Nothing was sent.";
export const COMMIT_BYTES_CHANGED = "Blast returned a different transaction. Nothing was signed.";
export const COMMIT_WALLET_BYTES_CHANGED = "Your wallet signed a different transaction. Nothing was sent.";

function buildFailure(built: Exclude<ApiResult<unknown>, { status: "ok" }>): CommitResult {
  const code = built.status === "refused" && built.code === "insufficient_balance" ? built.code : undefined;
  return { status: "failed", message: commitBuildRefusalMessage(built), digest: null, ...(code && { code }) };
}

export async function runCommit(deps: CommitDependencies, request: CommitRequest): Promise<CommitResult> {
  const blockers = deps.blockers ?? [];
  // Checked again here, not only when the dialog opened: a manifest can stop
  // being readable, and a sale can close, while the dialog is open.
  if (blockers.length > 0) return { status: "blocked", reasons: blockers };

  const { signer } = deps;
  deps.onPhase?.("preparing");
  // The server builds the commit for the account's Blast wallet: it holds the
  // deployment, the browser does not.
  const built = await requestCommitBuild(deps.api, {
    presale_id: request.presaleId,
    pay_with: request.order.payWith,
    amount: request.order.amount,
    ...(request.order.swapQuoteId ? { swap_quote_id: request.order.swapQuoteId } : {}),
    ...(request.order.allowlist ? { allowlist: request.order.allowlist } : {}),
  });
  if (built.status !== "ok") return buildFailure(built);
  const order = built.body;
  // Built for another wallet (the Blast wallet changed under the dialog), or another sale: nothing is signed.
  if (normalizeSuiAddress(order.sender) !== normalizeSuiAddress(signer.address) || order.presale_id !== request.presaleId) {
    return { status: "failed", message: diagnosticMessage(COMMIT_WALLET_NOT_READY, { code: "request_failed" }), digest: null };
  }
  let kind: Uint8Array;
  try {
    kind = fromBase64(order.transaction_kind_bytes);
  } catch {
    return { status: "failed", message: diagnosticMessage(COMMIT_BYTES_CHANGED, { code: "invalid_response" }), digest: null };
  }

  const intent: IntentRequest = {
    presaleId: request.presaleId,
    digest: "",
    sourceEntryId: request.sourceEntryId ?? null,
    why: request.why?.trim() ? request.why : null,
    // Exactly what the server built, for the account's log (R3-27).
    log: { quoteType: order.quote_type, quoteAmount: order.amount, usdValue: request.usdValue ?? null },
  };
  // Every commit registers, with or without a why or a source item: the
  // registration is also the commit's row in the account's transaction log
  // (R3-27), which the social worker settles from the chain. T-024-AC-3's
  // "no call without a why and a source" predates the log; the conflict is
  // reported in T-024's record. The call still never blocks (AC-096).
  const register = (digest: string, bytes: Uint8Array) =>
    registerIntentWithin(deps.api, { ...intent, digest, transactionBytes: toBase64(bytes) });

  // A swap-and-commit arrives already sponsored: the server reserved its gas while building it,
  // because the public sponsor route admits only configured swap packages, not the aggregator's route.
  let reservation = order.sponsored;
  if (!reservation) {
    const sponsored = await requestSponsorship(deps.api, {
      sender: signer.address,
      presale_id: request.presaleId,
      transaction_kind_bytes: order.transaction_kind_bytes,
      intent: "commit",
    });
    if (sponsored.status !== "ok") return { status: "failed", message: commitRefusalMessage(sponsored), digest: null };
    reservation = sponsored.body;
  }
  const bytes = readSponsoredBytes(reservation.transaction_bytes, kind, signer.address);
  if (bytes === null) return { status: "failed", message: diagnosticMessage(COMMIT_BYTES_CHANGED, { code: "invalid_response" }), digest: null };

  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  deps.onDigest?.(digest);
  const recorded = await register(digest, bytes);

  deps.onPhase?.("signing");
  const signed = await signExactly(signer, bytes);
  if (signed.status === "unsigned") return notSigned(signed);

  deps.onPhase?.("executing");
  const sent = await sendSponsored(deps.api, reservation.reservation_id, signed.signature);
  if (sent.status === "refused") return { status: "failed", message: commitRefusalMessage(sent.refusal), digest };
  switch (sent.executed) {
    case "unknown":
      return {
        status: "pending",
        message: diagnosticMessage(`Blast could not confirm your blast. Check ${digest} on Sui before blasting again.`, { code: "execution_unconfirmed", requestId: sent.requestId }),
        digest,
      };
    case "failure":
      return { status: "failed", message: diagnosticMessage("The blast failed on Sui. Your coins did not move.", { code: "execution_failed" }), digest };
    case "success":
      return { status: "sent", digest, amount: order.amount, why: recorded?.why ?? null, registered: recorded !== null };
  }
}

/** Nothing was sent: the signer declined, failed, or (a wallet session) signed other bytes than the sponsor's. */
function notSigned(unsigned: Unsigned): CommitResult {
  if (unsigned.reason === "mismatch") {
    return { status: "failed", message: diagnosticMessage(COMMIT_WALLET_BYTES_CHANGED, { code: "invalid_response" }), digest: null };
  }

  return unsigned.reason === "rejected"
    ? { status: "refused", message: diagnosticMessage(COMMIT_SIGNATURE_REFUSED, { code: "wallet_rejected" }) }
    : { status: "refused", message: diagnosticMessage("Your wallet could not sign it. Nothing was sent.", { code: "sign_failed" }) };
}
