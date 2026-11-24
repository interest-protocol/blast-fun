import { fromBase64, toBase64 } from "@mysten/sui/utils";

import {
  isSocialClaimKind,
  type SocialClaim,
  type SocialClaimClientFailure,
  type SocialClaimRequest,
} from "@blast/core/web/contracts/claims.ts";
import { isCreatorActionKind } from "@blast/core/web/contracts/creator-earnings.ts";

import type { ApiResult, SocialApiOptions } from "#web/components/social/social-api.ts";
import {
  pollSettlement,
  requestSponsorship,
  signSponsored,
  type ApiRefusal,
  type Sent,
  type Signed,
  type SponsoredSigner,
  type SponsoredTransaction,
  type Unsigned,
} from "#web/components/social/sponsored-transaction.ts";
import type { ErrorDiagnostic } from "#web/lib/errors.ts";

import { CLAIM_UNREACHABLE, type ClaimOutcome, type PresaleClaimTarget } from "./claims";
import { putClaim } from "./claim-client";

/**
 * One presale claim (R3-63), from a press of `Claim` to its answer — the
 * `ClaimPath` every claim button runs (Blast mode's Act now and side panel,
 * the sale page's side box).
 *
 * The order is the contract's, so no claim can fail silently (§22.1 defect 2)
 * and nothing is executed that the account's log does not hold:
 *
 * 1. **Record** the attempt (`PUT /api/social/me/claims/{id}`). The server
 *    checks the claim is open for the Blast wallet, builds it, dry-runs it,
 *    and logs it **before anything is signed**; it answers the transaction
 *    kind to sign, or a refusal naming the published abort.
 * 2. **Sign.** Sponsored (a Privy embedded wallet or a wallet session, owner
 *    ruling 2026-11-20 reversing OA-17; Blast pays the fee): the presale
 *    sponsor's `claim` intent (the kind must claim for the sender itself; the
 *    sponsor's policy checks it), the returned bytes checked to be exactly
 *    that kind from that sender, then the wallet signs exactly them.
 * 3. **Record the digest** before executing: a claim whose digest the log
 *    does not hold is never sent.
 * 4. **Execute** (through the sponsor) and **settle**:
 *    the server reads the fullnode; while it does not show the transaction
 *    yet the flow asks again a few times, then answers with what the
 *    execution itself said.
 *
 * Whatever stops it before a digest — the wallet declined, a dry run
 * refused — is reported to the server, so the attempt is a failed row of
 * `This session` rather than a pending one. Each attempt is its own request
 * id: a retry is a new attempt, and the chain refuses a second claim of the
 * same position (`ENoCommitment`), so nothing is ever claimed twice.
 */

/** The Blast wallet's signer, on Blast's gas: it signs only; the flow executes. */
export type ClaimSigner = SponsoredSigner;

export type ClaimFlowDependencies = Readonly<{
  api: SocialApiOptions;
  /** The Blast wallet's signer at the press, or null while it is not ready. */
  signer: () => Promise<ClaimSigner | null>;
}>;

/** The claim was sent and has not shown up on Sui yet: the worker settles it; `This session` shows it `Pending`. */
export const CLAIM_PENDING = "claim_pending";

export async function runClaim(deps: ClaimFlowDependencies, target: PresaleClaimTarget, signal: AbortSignal): Promise<ClaimOutcome> {
  if (!isSupportedTarget(target)) {
    return failed("claim_unsupported");
  }

  const signer = await deps.signer();
  if (signer === null) {
    return failed("blast_wallet_missing");
  }

  const requestId = crypto.randomUUID();
  const body = claimRequest(target);
  const recorded = await putClaim(deps.api, requestId, body);
  if (recorded.status !== "ok") {
    return failed(refusalCode(recorded), recorded);
  }

  const record = recorded.body;
  if (record.state === "failed") {
    return failed(claimFailureCode(record));
  }

  if (record.state === "confirmed" && record.digest !== null) {
    return { status: "confirmed", digest: record.digest };
  }

  const encoded = record.transaction_kind_bytes;
  if (encoded === null) {
    return failed(CLAIM_UNREACHABLE);
  }

  let kind: Uint8Array;
  try {
    kind = fromBase64(encoded);
  } catch {
    return failed("mismatch");
  }

  /** Nothing was sent: say why to the server (best effort), then answer `code`. */
  const stop = async (failure: SocialClaimClientFailure, code: string): Promise<ClaimOutcome> => {
    await putClaim(deps.api, requestId, { ...body, failure });
    return failed(code);
  };

  const sponsored = await sponsorClaim(deps, signer.address, target, encoded);
  if (sponsored.status === "refused" && sponsored.code === "dry_run_failed") {
    return stop("dry_run_failed", "dry_run_failed");
  }

  // The sponsor could not take it now (its pool, its budget): nothing was signed. The attempt expires.
  if (sponsored.status !== "ok") {
    return failed(refusalCode(sponsored), sponsored);
  }

  const signed = await signClaim(deps, kind, signer, sponsored.body, signal);
  if (signed === null) {
    return failed(CLAIM_UNREACHABLE);
  }

  if (signed.status === "unsigned") {
    // Nothing was signed: the server logs a refusal (the sponsor dry-runs before the wallet signs).
    return stop("rejected", signed.reason);
  }

  return sendClaim<SocialClaim>(deps, signed, (fields) => putClaim(deps.api, requestId, { ...body, ...fields }), claimFailureCode);
}

/**
 * The code a failed claim is shown with: the presale abort's own meaning
 * where it names one (`ENoCommitment`: the position was already claimed, by
 * another tab or anyone's permissionless claim; `EInvalidLifecycle`: the sale has not
 * settled), else the log's published code.
 */
export function claimFailureCode(claim: Pick<SocialClaim, "failure_code" | "move_abort">): string {
  if (claim.move_abort === "ENoCommitment") {
    return "already_claimed";
  }

  if (claim.move_abort === "EInvalidLifecycle") {
    return "claim_not_open";
  }

  // A vesting schedule with nothing unlocked since its last claim (P-13).
  if (claim.move_abort === "ENothingClaimable") {
    return "nothing_to_claim";
  }

  return claim.failure_code ?? "execution_failed";
}

/**
 * Signs the sponsor's bytes for a claim's kind (Blast pays). Null when there
 * is no sponsorship to sign.
 */
export function signClaim(
  deps: ClaimFlowDependencies,
  kind: Uint8Array,
  signer: ClaimSigner,
  sponsorship: SponsoredTransaction | null,
  signal: AbortSignal,
): Promise<Signed | Unsigned | null> {
  if (sponsorship === null) {
    return Promise.resolve(null);
  }

  return signSponsored({ api: deps.api, sponsorship, kind, signer, signal });
}

/**
 * Records a signed claim's digest in its log, then sends it and settles it:
 * the log's word once the fullnode shows it, else what executing said.
 * A claim whose digest the log does not hold is never sent.
 */
export async function sendClaim<Logged extends Readonly<{ state: string }>>(
  deps: ClaimFlowDependencies,
  signed: Signed,
  log: (fields: Readonly<{ digest: string; transaction_bytes?: string }>) => Promise<ApiResult<Logged>>,
  failureCode: (logged: Logged) => string,
): Promise<ClaimOutcome> {
  const { digest } = signed;
  const noted = await log({ digest, transaction_bytes: toBase64(signed.bytes) });
  if (noted.status !== "ok") {
    return failed(refusalCode(noted), noted);
  }

  const sent = await signed.send();
  if (sent.status === "refused") {
    return failed(refusalCode(sent.refusal), sent.refusal);
  }

  const settled = await pollSettlement(() => log({ digest }), isSubmitted);
  if (settled?.state === "confirmed") {
    return { status: "confirmed", digest };
  }

  if (settled?.state === "failed") {
    return failed(failureCode(settled));
  }

  return executedOutcome(digest, sent);
}

/** What executing said, while the fullnode does not show the claim yet: the worker settles the row later. */
export function executedOutcome(digest: string, sent: Extract<Sent, { status: "executed" }>): ClaimOutcome {
  if (sent.executed === "success") {
    return { status: "confirmed", digest };
  }

  if (sent.executed === "failure") {
    return failed("execution_failed");
  }

  return { status: "failed", code: CLAIM_PENDING, digest, ...(sent.requestId ? { requestId: sent.requestId } : {}) };
}

export function failed(code: string, diagnostic: ErrorDiagnostic = {}): ClaimOutcome {
  return { status: "failed", code, ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {}) };
}

/** A refused or unreachable call's code: the route's published one, or `claim_unreachable`. */
export function refusalCode(result: ApiRefusal): string {
  return result.status === "error" ? CLAIM_UNREACHABLE : result.code;
}

function isSubmitted(claim: Readonly<{ state: string }>): boolean {
  return claim.state === "submitted";
}

/** The presale sponsor's `claim` intent: the kind must claim for the sender itself (the sponsor's policy checks it). */
function sponsorClaim(deps: ClaimFlowDependencies, sender: string, target: PresaleClaimTarget, encoded: string): Promise<ApiResult<SponsoredTransaction>> {
  return requestSponsorship(deps.api, { sender, presale_id: target.presaleId, transaction_kind_bytes: encoded, intent: "claim" });
}

function isSupportedTarget(target: PresaleClaimTarget): boolean {
  return isSocialClaimKind(target.kind) && (target.kind === "claim_vesting") === (target.scheduleId !== undefined)
    && isCreatorActionKind(target.kind) === (target.vaultId !== undefined);
}

function claimRequest(target: PresaleClaimTarget): SocialClaimRequest {
  return {
    presale_id: target.presaleId,
    kind: target.kind,
    ...(target.scheduleId === undefined ? {} : { schedule_id: target.scheduleId }),
    ...(target.vaultId === undefined ? {} : { vault_id: target.vaultId }),
  };
}
