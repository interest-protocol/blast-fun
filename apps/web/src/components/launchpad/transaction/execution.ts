import { sendSponsored } from "#web/components/social/sponsored-transaction.ts";
import { diagnosticMessage, PublicError } from "#web/lib/errors.ts";
import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchpadEvent } from "@interest-protocol/blast-sdk/launchpad";
import { decodeMigratorsEvent } from "@interest-protocol/blast-sdk/migrators";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, parseStructTag, toBase64 } from "@mysten/sui/utils";

import type { FreshReview, ReconciliationOutcome } from "./action-machine.ts";
import { explorerTransactionUrl } from "./explorer.ts";
import type { CompletionExpectation } from "./preflight.ts";
import { isUserRejection, type LaunchpadSigner } from "./signer.ts";
import { reportWalletSigningFailure } from "./signing-diagnostics.ts";

export type SubmissionResult =
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "signature-failed"; message: string }>
  | Readonly<{ status: "submitted"; digest: string }>
  | Readonly<{ status: "unknown"; digest: string; message: string }>;

const RECONCILE_TIMEOUT_MS = 30_000;

/**
 * Requests exactly one signature for the reviewed bytes and submits the signed
 * transaction exactly once. It never retries: a lost submission answer is
 * reported with the transaction's digest so it can be reconciled by reading.
 */
export async function signAndSubmitOnce({
  client,
  signer,
  review,
  onSigned,
}: Readonly<{
  client: ClientWithCoreApi;
  signer: LaunchpadSigner;
  review: FreshReview;
  /**
   * Optional: runs once after the wallet returns a valid signature and before
   * the transaction is sent, with the signed transaction's digest, so a
   * caller can record that signed bytes may now reach the chain. It is
   * awaited; if it throws or rejects, nothing is submitted.
   */
  onSigned?: (digest: string) => void | Promise<void>;
}>): Promise<SubmissionResult> {
  const bytes = review.transactionBytes;
  let signature: string;
  try {
    const signed = await signer.signTransaction(bytes);
    if (signed.bytes !== toBase64(bytes)) {
      return {
        status: "signature-failed",
        message: diagnosticMessage("The wallet returned a different transaction from the one you reviewed, so it was not submitted.", { code: "invalid_response" }),
      };
    }
    signature = signed.signature;
  } catch (error) {
    if (isUserRejection(error)) return { status: "rejected" };
    reportWalletSigningFailure(signer.kind, error);
    return {
      status: "signature-failed",
      message: diagnosticMessage("The wallet could not sign. Reconnect it and retry. Nothing was submitted.", { ...(error instanceof PublicError ? error : {}), code: "sign_failed" }),
    };
  }
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  try {
    await onSigned?.(digest);
  } catch (error) {
    return {
      status: "signature-failed",
      message: diagnosticMessage("The signed transaction could not be recorded, so it was not submitted.", { ...(error instanceof PublicError ? error : {}), code: "transaction_record_failed" }),
    };
  }
  try {
    const refused = await submitReviewed(client, signer, review, signature, digest);
    if (refused) return refused;
  } catch (error) {
    return {
      status: "unknown",
      digest,
      message: diagnosticMessage(`Sui did not confirm whether transaction ${digest} was received. Do not sign again until it is resolved.`, { ...(error instanceof PublicError ? error : {}), code: "execution_unconfirmed" }),
    };
  }
  return { status: "submitted", digest };
}

async function submitReviewed(client: ClientWithCoreApi, signer: LaunchpadSigner, review: FreshReview, signature: string, digest: string): Promise<SubmissionResult | null> {
  if (review.sponsorReservationId) return submitSponsoredReview(review.sponsorReservationId, signer, signature, digest);
  await client.core.executeTransaction({ transaction: review.transactionBytes, signatures: [signature] });
  return null;
}

async function submitSponsoredReview(reservationId: string, signer: LaunchpadSigner, signature: string, digest: string): Promise<SubmissionResult | null> {
  const sent = await sendSponsored({ getAccessToken: signer.accessToken ?? (async () => null), signal: AbortSignal.timeout(30_000) }, reservationId, signature);
  if (sent.status === "refused") {
    return { status: "signature-failed", message: diagnosticMessage("Blast could not sponsor this trade. Nothing was submitted. Review again to retry.", sent.refusal) };
  }
  // A digest is present only when the sponsor executed; a missing or different one means these bytes may still be on Sui.
  if (sent.digest !== digest) {
    throw new Error("Sponsor submission unconfirmed");
  }
  return null;
}

function eventEntries(
  transaction: SuiClientTypes.Transaction<{ effects: true; events: true; objectTypes: true }>,
  checkpoint: string,
) {
  return (transaction.events ?? []).map((event, eventIndex) => ({
    ...event,
    checkpoint,
    transactionDigest: transaction.digest,
    eventIndex,
  }));
}

function hasCompletionEvidence(
  transaction: SuiClientTypes.Transaction<{ effects: true; events: true; objectTypes: true }>,
  completion: CompletionExpectation,
  deployment: BlastDeployment,
  checkpoint: string,
): boolean {
  if (completion.kind === "check") {
    try {
      return completion.check({ digest: transaction.digest, status: transaction.status, events: transaction.events ?? [] });
    } catch {
      return false;
    }
  }
  if (completion.kind === "event") {
    const packages = deployment.packages[completion.source];
    if (!packages) return false;
    return eventEntries(transaction, checkpoint).some((event) => {
      try {
        const decoded =
          completion.source === "launchpad"
            ? decodeLaunchpadEvent(event, packages)
            : decodeMigratorsEvent(event, packages);
        return decoded.kind === completion.event;
      } catch {
        return false;
      }
    });
  }
  const original = deployment.packages[completion.lineage]?.originalPackageId;
  if (!original) return false;
  return transaction.effects.changedObjects.some((object) => {
    const type = transaction.objectTypes?.[object.objectId];
    if (object.idOperation !== "Created" || !type) return false;
    try {
      const tag = parseStructTag(type);
      return (
        tag.address === normalizeSuiAddress(original) && tag.module === completion.module && tag.name === completion.name
      );
    } catch {
      return false;
    }
  });
}

/**
 * Reads a submitted transaction by digest. Success requires checkpointed
 * effects that succeeded and the expected event or object from the accepted
 * deployment's packages; anything less stays pending, never success.
 */
export async function reconcileTransaction({
  client,
  deployment,
  digest,
  completion,
  timeoutMs = RECONCILE_TIMEOUT_MS,
}: Readonly<{
  client: ClientWithCoreApi;
  deployment: BlastDeployment;
  digest: string;
  completion: CompletionExpectation;
  timeoutMs?: number;
}>): Promise<ReconciliationOutcome> {
  const pending: ReconciliationOutcome = {
    status: "pending",
    reason: "confirmation-pending",
    message: diagnosticMessage(`Sui has not confirmed transaction ${digest} yet. Check again before signing anything new.`, { code: "execution_unconfirmed" }),
  };
  let result: SuiClientTypes.TransactionResult<{ effects: true; events: true; objectTypes: true }>;
  try {
    result = await client.core.waitForTransaction({
      digest,
      include: { effects: true, events: true, objectTypes: true },
      timeout: timeoutMs,
    });
  } catch {
    return pending;
  }
  const transaction = result.Transaction ?? result.FailedTransaction;
  if (!transaction?.effects || transaction.checkpoint === null || transaction.effects.transactionDigest !== digest) {
    return pending;
  }
  const explorerUrl = explorerTransactionUrl(deployment, digest);
  const status = transaction.effects.status;
  if (!status.success) {
    return {
      status: "failed",
      explorerUrl,
      message: diagnosticMessage("The transaction failed on Sui: the network rejected it. Its changes were reverted; only network fees were spent.", { code: "execution_failed" }),
    };
  }
  if (!hasCompletionEvidence(transaction, completion, deployment, transaction.checkpoint)) {
    return {
      status: "pending",
      reason: "evidence-missing",
      message: diagnosticMessage(`Transaction ${digest} completed, but its expected Blast record was not found. Check the transaction before signing again.`, { code: "evidence-missing" }),
    };
  }
  return { status: "succeeded", explorerUrl };
}
