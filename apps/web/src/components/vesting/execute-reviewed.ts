import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromBase64 } from "@mysten/sui/utils";
import { createMainnetClient, executeSponsored } from "#web/components/social/sponsored-transaction.ts";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import type { VestingAttempt } from "@blast/core/modules/vesting/model.ts";
import { VestingReviewRequiredError, VestingSubmissionPendingError } from "./vesting-errors.ts";

export { VestingReviewRequiredError, VestingSubmissionPendingError };

const client = createMainnetClient();

const SPONSOR_PRE_SUBMISSION_REFUSALS = new Set([
  "reservation_expired", "invalid_signature", "rate_limited", "unauthorized",
  "not_found", "invalid_parameter", "invalid_request", "origin_invalid", "body_too_large",
]);


/** Reconcile the recorded digest before signing or retrying; only a sponsored review is signed and sent. */
export async function executeReviewedVesting(
  attempt: VestingAttempt,
  dependencies: {
    refresh: (attempt: VestingAttempt) => Promise<VestingAttempt>;
    signTransaction: (bytes: Uint8Array) => Promise<string>;
    setPhase: (phase: string) => void;
    api: SocialApiOptions;
    chain?: Pick<SuiGrpcClient, "core">;
  },
): Promise<VestingAttempt> {
  const {
    refresh,
    signTransaction,
    setPhase,
    api,
    chain = client,
  } = dependencies;
  let submissionStarted = false;
  try {
    const current = await refresh(attempt);
    if (current.state !== "submitted") return current;
    if (Date.now() >= attempt.expires_at_ms)
      throw new VestingReviewRequiredError(
        "This review expired. Review the current schedule again.",
      );
    // Every review is sponsored; a historical wallet-gas review is never sent.
    const reservationId = attempt.sponsor_reservation_id;
    if (!reservationId)
      throw new VestingReviewRequiredError(
        "The gas payer changed. Review this schedule again with your current wallet.",
      );
    const bytes = fromBase64(attempt.transaction_bytes);
    setPhase("Awaiting wallet approval…");
    const signature = await signTransaction(bytes);
    // Wallet approval can take longer than the sponsor reservation's lifetime.
    if (Date.now() >= attempt.expires_at_ms)
      throw new VestingReviewRequiredError(
        "This review expired. Review the current schedule again.",
      );
    setPhase("Submitting transaction…");
    submissionStarted = true;
    await submitSponsoredVesting(api, attempt, reservationId, signature);
    setPhase("Confirming transaction…");
    await chain.core.waitForTransaction({
      digest: attempt.digest,
      timeout: 30_000,
    });
    return await refresh(attempt);
  } catch (error) {
    // A lost response can follow execution. Never ask to sign again before checking the original digest.
    const current = await refresh(attempt).catch(() => null);
    if (current && current.state !== "submitted") return current;
    const message = error instanceof Error ? error.message : "Could not complete the transaction.";
    if (submissionStarted && !(error instanceof VestingReviewRequiredError))
      throw new VestingSubmissionPendingError(message, { cause: error });
    throw new VestingReviewRequiredError(message, { cause: error });
  }
}

async function submitSponsoredVesting(
  api: SocialApiOptions,
  attempt: VestingAttempt,
  reservationId: string,
  signature: string,
) {
  const executed = await executeSponsored(api, reservationId, signature);
  if (executed.status === "error" && executed.code === "authentication_unavailable")
    throw new VestingReviewRequiredError("Your session could not be checked. Sign in again, then review the schedule.");
  if (executed.status === "refused" && SPONSOR_PRE_SUBMISSION_REFUSALS.has(executed.code))
    throw new VestingReviewRequiredError(
      executed.code === "reservation_expired"
        ? "This review expired. Review the current schedule again."
        : "The sponsor refused this request before submission. Review the schedule again.",
    );
  if (executed.status !== "ok")
    throw new Error(
      executed.code === "reservation_expired"
        ? "This review expired. Review the current schedule again."
        : "Blast could not confirm this transaction. Check its status before retrying.",
    );
  if (executed.body.digest !== attempt.digest)
    throw new Error(
      "The sponsor returned a different transaction. Check its status before retrying.",
    );
}
