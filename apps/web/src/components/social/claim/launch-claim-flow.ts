import { fromBase64 } from "@mysten/sui/utils";

import type { SocialClaimClientFailure } from "@blast/core/web/contracts/claims.ts";
import type { LaunchClaimRequest } from "@blast/core/web/contracts/launch-claims.ts";

import { CLAIM_UNREACHABLE, type ClaimOutcome, type LaunchClaimTarget } from "./claims";
import { failed, refusalCode, sendClaim, signClaim, type ClaimFlowDependencies } from "./claim-flow";
import { putLaunchClaim } from "./launch-claim-client";

/**
 * One launch creator fee claim (LP-12), from a press of `Claim` to its answer, in the presale
 * claim's order (`claim-flow.ts`), so nothing is executed that the account's log does not hold:
 *
 * 1. **Record** (`PUT /api/social/me/launch-claims/{id}`): the server checks on chain that the
 *    Blast wallet holds the launch's cap and something is unclaimed, builds and dry-runs the
 *    claim, and logs it before anything is signed. It answers the sponsored transaction too
 *    (Blast pays the fee, for a Privy embedded wallet and a wallet session alike); the bytes
 *    must be exactly the recorded kind from this sender before the wallet signs them.
 * 2. **Record the digest** before executing.
 * 3. **Execute** through the sponsor and **settle**, asking again a few
 *    times while the fullnode does not show it yet.
 *
 * Whatever stops it before a digest is reported to the server, so the attempt is a failed row
 * of `This session` rather than a pending one.
 */

export async function runLaunchClaim(deps: ClaimFlowDependencies, target: LaunchClaimTarget, signal: AbortSignal): Promise<ClaimOutcome> {
  const signer = await deps.signer();
  if (signer === null) {
    return failed("blast_wallet_missing");
  }

  const requestId = crypto.randomUUID();
  const body = claimRequest(target);
  const recorded = await putLaunchClaim(deps.api, requestId, body);
  if (recorded.status !== "ok") {
    return failed(refusalCode(recorded), recorded);
  }

  const claim = recorded.body;
  if (claim.state === "failed") {
    return failed(claim.failure_code ?? "execution_failed");
  }

  if (claim.state === "confirmed" && claim.digest !== null) {
    return { status: "confirmed", digest: claim.digest };
  }

  if (claim.transaction_kind_bytes === null) {
    return failed(CLAIM_UNREACHABLE);
  }

  let kind: Uint8Array;
  try {
    kind = fromBase64(claim.transaction_kind_bytes);
  } catch {
    return failed("mismatch");
  }

  /** Nothing was sent: say why to the server (best effort), then answer `code`. */
  const stop = async (failure: SocialClaimClientFailure, code: string): Promise<ClaimOutcome> => {
    await putLaunchClaim(deps.api, requestId, { ...body, failure });
    return failed(code);
  };

  // The sponsor answers with the record; without it nothing is signed, and the unsent attempt expires.
  const signed = await signClaim(deps, kind, signer, claim.sponsored, signal);
  if (signed === null) {
    return failed(CLAIM_UNREACHABLE);
  }

  if (signed.status === "unsigned") {
    return stop("rejected", signed.reason);
  }

  return sendClaim(deps, signed, (fields) => putLaunchClaim(deps.api, requestId, { ...body, ...fields }), (logged) => logged.failure_code ?? "execution_failed");
}

function claimRequest(target: LaunchClaimTarget): LaunchClaimRequest {
  return { launch_id: target.launchId, kind: target.kind };
}
