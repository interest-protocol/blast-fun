import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";

import type { CreatorCapsClaim } from "@blast/core/web/contracts/creator-claims.ts";

import { CLAIM_UNREACHABLE, type ClaimOutcome, type CreatorCapsClaimTarget } from "./claims";
import { executedOutcome, failed, refusalCode, signClaim, type ClaimFlowDependencies, type ClaimSigner } from "./claim-flow";
import { requestCreatorCaps } from "./creator-caps-client";

/**
 * One claim of a launch's creator rights (LP-17): both of its caps, `CurveFeeCap` and
 * `BlastMetadataCap`, to the caller's Blast wallet, in one transaction the server builds.
 *
 * 1. **Request** (`POST /api/social/me/creator-caps`): the server reads the launch on chain,
 *    checks its unclaimed recipient is this caller (the Blast wallet, or the account's
 *    commitment), signs an account claim's expiring attestation for the Blast wallet, dry-runs
 *    the claim and sponsors it (Blast pays its gas). Its refusals are the answer.
 * 2. **Check** the answer is this launch's claim, for this signer's wallet and fee arm; the
 *    sponsored bytes must be exactly the kind from this sender.
 * 3. **Sign**, then **execute** through the sponsor.
 *
 * An attestation (or a sponsorship) that has run out, or would before the transaction could land,
 * is never sent: the flow asks the server again, which checks the recipient again, so a launch
 * claimed elsewhere meanwhile is refused (`creator_caps_claimed`) rather than retried. After
 * `MAX_REQUESTS` stale answers it stops with `attestation_expired`.
 *
 * Nothing is logged for this claim: its `CreatorCapsClaimed` event is the record, and the
 * screen reads blast-infra again after any answer rather than guessing what changed.
 */

export type CreatorCapsFlowDependencies = ClaimFlowDependencies;

/** How long a signed claim needs before its attestation or sponsorship runs out, to reach the chain. */
export const CREATOR_CAPS_SEND_MARGIN_MS = 20_000;

/** How many times one press asks the server for a claim whose approval has not run out. */
export const CREATOR_CAPS_MAX_REQUESTS = 2;

/** The claim's approval ran out before it could be sent, every time it was asked for. */
export const ATTESTATION_EXPIRED = "attestation_expired";

export async function runCreatorCapsClaim(deps: CreatorCapsFlowDependencies, target: CreatorCapsClaimTarget, signal: AbortSignal): Promise<ClaimOutcome> {
  const signer = await deps.signer();
  if (signer === null) {
    return failed("blast_wallet_missing");
  }

  for (let request = 0; request < CREATOR_CAPS_MAX_REQUESTS; request += 1) {
    const answer = await requestCreatorCaps(deps.api, target.launchId);
    if (answer.status !== "ok") {
      return failed(refusalCode(answer), answer);
    }

    const claim = answer.body;
    const kind = claimKind(claim, target, signer);
    if (kind === null) {
      return failed("mismatch");
    }

    const deadline = deadlineOf(claim);
    const sendable = () => deadline === null || Date.now() + CREATOR_CAPS_SEND_MARGIN_MS < deadline;
    // Stale on arrival: ask again rather than sign what the chain would refuse.
    if (!sendable()) {
      continue;
    }

    const signed = await signClaim(deps, kind, signer, claim.sponsored, signal);
    // Nothing signed: no sponsorship came with a sponsored claim, or the signer refused or broke.
    if (signed === null || signed.status === "unsigned") {
      return failed(signed?.reason ?? CLAIM_UNREACHABLE);
    }

    // The wallet was open past the approval's time: this signature is dropped, never sent.
    if (!sendable()) {
      continue;
    }

    const sent = await signed.send();
    return sent.status === "refused" ? failed(refusalCode(sent.refusal), sent.refusal) : executedOutcome(signed.digest, sent);
  }

  return failed(ATTESTATION_EXPIRED);
}

/** When the claim stops being sendable: the attestation's expiry, or the sponsorship's, whichever is first; null when neither expires. */
function deadlineOf(claim: CreatorCapsClaim): number | null {
  const ends = [claim.attestation_expires_at_ms, claim.sponsored?.expires_at_ms ?? null].filter((end): end is number => end !== null);
  return ends.length === 0 ? null : Math.min(...ends);
}

/** The claim's kind when it is this launch's, for this signer's wallet and fee arm; otherwise `mismatch`. */
function claimKind(claim: CreatorCapsClaim, target: CreatorCapsClaimTarget, signer: ClaimSigner): Uint8Array | null {
  // The server builds for the Blast wallet it knows; a claim for another launch, wallet or fee arm is not signed.
  if (claim.launch_id !== target.launchId || normalizeSuiAddress(claim.claimant) !== normalizeSuiAddress(signer.address) || claim.fee !== signer.fee) {
    return null;
  }

  try {
    return fromBase64(claim.transaction_kind_bytes);
  } catch {
    return null;
  }
}
