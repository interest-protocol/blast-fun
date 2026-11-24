import { readCurrencyRegistration } from "@interest-protocol/blast-sdk";
import { readLaunchCreation, readMemePublication } from "@interest-protocol/blast-sdk/launchpad";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { match } from "ts-pattern";
import { z } from "zod";

import { launchSigningPublishPlanSchema, type LaunchPublishCoin, type LaunchPublishStepKind } from "@blast/core/web/contracts/launch.ts";
import { PublicError } from "#web/lib/errors.ts";

import { readSponsoredBytes } from "#web/lib/sui-signing.ts";
import { findPublishedCurrency, findTransaction, readPublishProgress, savedTransactionFields, sendPublishTransaction, type ConfirmedTransaction, type PublishSigner, type TransactionResult } from "#web/components/social/publish-transaction.ts";
import { recordLaunchPublished, requestLaunchStep, type LaunchApiOptions } from "./launch-client.ts";
import { launchSignLabel } from "./launch-publish-labels.ts";
import { signLabelText } from "../create/create-review-model.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const savedSchema = z.strictObject({
  ...savedTransactionFields,
  package: z.string().regex(SUI_OBJECT_ID_PATTERN),
  corePackage: z.string().regex(SUI_OBJECT_ID_PATTERN).optional(),
});
const checkpointSchema = z.strictObject({
  version: z.number().int().positive(),
  transactions: z.strictObject({
    publish_coin: savedSchema.optional(),
    register_currency: savedSchema.optional(),
    create_launch: savedSchema.optional(),
  }),
});
type Saved = z.infer<typeof savedSchema>;
type Checkpoint = z.infer<typeof checkpointSchema>;

export type LaunchPublishInput = Readonly<{
  api: LaunchApiOptions;
  client: ClientWithCoreApi;
  storage: Storage;
  draftId: string;
  version: number;
  creator: string;
  fee: PublishSigner["fee"];
  sign: PublishSigner["sign"];
  /** The step now running, for the progress sheet. */
  progress(step: LaunchPublishStepKind): void;
  onConfirmed?(step: LaunchPublishStepKind, digest: string): void;
}>;

export const launchProgressKey = (draftId: string, creator: string) => `blast:launch:publish:v1:${creator}:${draftId}`;

/**
 * Publishes a finished launch draft: the coin, its registration (skipped
 * when the registry already shares it), then the launch with the first buy.
 * Each transaction is saved before it is broadcast and a retry reuses its
 * digest, so a closed tab or a lost answer never sends a step twice.
 * Answers the launch id once the server recorded it.
 */
export async function publishLaunch(input: LaunchPublishInput): Promise<string> {
  const checkpoint = loadProgress(input);
  const publication = await confirmStep(input, checkpoint, "publish_coin", null);
  const saved = checkpoint.transactions.publish_coin!;
  const launchpad = saved.package;
  if (!saved.corePackage) throw new PublicError("This coin belongs to an earlier Blast deployment. Keep the draft and contact support.");
  const coin = readMemePublication(publication, { originalPackageId: launchpad, core: { originalPackageId: saved.corePackage } });
  if (coin.ticket.owner !== input.creator) throw new PublicError("This publication did not deliver the launch ticket to your wallet.");

  input.api.signal?.throwIfAborted();
  input.progress("register_currency");
  let currency = await findPublishedCurrency(input, coin.memeType, checkpoint.transactions.register_currency);
  if (!currency) {
    try {
      const registration = await confirmStep(input, checkpoint, "register_currency", {
        coin_type: coin.memeType,
        currency: { object_id: coin.pendingCurrency.objectId, version: coin.pendingCurrency.version, digest: coin.pendingCurrency.digest },
      });
      const shared = readCurrencyRegistration(registration, coin.memeType);
      currency = { objectId: shared.objectId, initialSharedVersion: String(shared.initialSharedVersion) };
    } catch (error) {
      input.api.signal?.throwIfAborted();
      // Registration is permissionless; Blast's worker may have shared the currency first.
      currency = await findPublishedCurrency(input, coin.memeType, checkpoint.transactions.register_currency);
      if (!currency) throw error;
    }
  }

  if (!currency) throw new PublicError("The coin registration could not be confirmed. Retry to resume.");
  const created = await confirmStep(input, checkpoint, "create_launch", {
    coin_type: coin.memeType,
    sealed_treasury_cap: { object_id: coin.sealedTreasuryCap.objectId, version: coin.sealedTreasuryCap.version, digest: coin.sealedTreasuryCap.digest },
    ticket: { object_id: coin.ticket.objectId, version: coin.ticket.version, digest: coin.ticket.digest },
    currency: { object_id: currency.objectId, initial_shared_version: String(currency.initialSharedVersion) },
  });
  const launchId = readLaunchCreation(created, launchpad).launch.objectId;

  input.api.signal?.throwIfAborted();
  const recorded = await recordLaunchPublished(input.api, input.draftId, launchId);
  if (recorded.status !== "ok") {
    throw new PublicError("Your coin is trading. Its cover and links couldn’t save yet; retry to finish without launching again.", recorded);
  }
  try {
    input.storage.removeItem(launchProgressKey(input.draftId, input.creator));
  } catch {
    // The launch is recorded; storage cleanup cannot undo it.
  }
  return launchId;
}

async function confirmStep(input: LaunchPublishInput, checkpoint: Checkpoint, step: LaunchPublishStepKind, coin: LaunchPublishCoin | null): Promise<ConfirmedTransaction> {
  input.api.signal?.throwIfAborted();
  input.progress(step);
  const saved = checkpoint.transactions[step];
  const existing = saved ? await findTransaction(input.client, saved.digest) : null;
  const result = existing ?? (await signAndSubmit(input, checkpoint, step, coin));
  return match(result)
    .with({ $kind: "Transaction" }, ({ Transaction: transaction }) => {
      input.onConfirmed?.(step, transaction.digest);
      return transaction;
    })
    .with({ $kind: "FailedTransaction" }, () => {
      delete checkpoint.transactions[step];
      saveProgress(input, checkpoint);
      throw new PublicError(`${signLabelText(launchSignLabel(step, ""))} failed on-chain.`);
    })
    .exhaustive();
}

async function signAndSubmit(input: LaunchPublishInput, checkpoint: Checkpoint, step: LaunchPublishStepKind, coin: LaunchPublishCoin | null): Promise<TransactionResult> {
  const prepared = await prepare(input, step, coin);
  input.api.signal?.throwIfAborted();
  checkpoint.transactions[step] = prepared;
  saveProgress(input, checkpoint);
  const confirmed = await findTransaction(input.client, prepared.digest);
  if (confirmed) return confirmed;

  return sendPublishTransaction(input, prepared, {
    cancelled: "Launching was cancelled in your wallet.",
    unconfirmed: "Blast could not confirm this step.",
    keep: () => {
      checkpoint.transactions[step] = prepared;
      saveProgress(input, checkpoint);
    },
    drop: () => {
      delete checkpoint.transactions[step];
      saveProgress(input, checkpoint);
    },
  });
}

/** The refusal's words for the creator. The draft and finished steps are always kept; the paused sheet's note says so, once. */
function refusalMessage(code: string, error: Readonly<Record<string, unknown>>): string {
  if (code === "draft_incomplete") return "Finish the highlighted fields first.";
  if (code === "draft_published") return "This coin was already created, from this draft on another device. Finish there, or start a new launch.";
  if (code === "draft_conflict") return "This draft changed in another tab. Reload to see the latest version.";
  if (code === "blocked_term") return "The name, ticker or description uses a word Blast doesn’t allow. Change it and retry.";
  if (code === "publish_unavailable") return "Launching isn’t available right now.";
  if (code === "rate_limited" || code === "budget_exceeded") {
    return error.reason === "daily_limit"
      ? "You’ve reached today’s limit for Blast-paid network fees. Try again after 00:00 UTC."
      : "Blast-paid network fees are limited right now. Try again shortly.";
  }
  if (code === "service_unavailable") return "Launching is temporarily unavailable. Retry in a few minutes.";
  return "Launching was refused.";
}

async function prepare(input: LaunchPublishInput, step: LaunchPublishStepKind, coin: LaunchPublishCoin | null): Promise<Saved> {
  const response = await requestLaunchStep(input.api, input.draftId, input.version, input.creator, step, coin, input.fee);
  const plan = match(response)
    .with({ status: "ok" }, ({ body }) => {
      const parsed = launchSigningPublishPlanSchema.safeParse(body);
      if (!parsed.success) throw new PublicError("The server returned an invalid launch step.", { code: "invalid_response" });
      return parsed.data;
    })
    .with({ status: "refused" }, ({ code, error, requestId }) => {
      throw new PublicError(refusalMessage(code, error), { code, requestId });
    })
    .with({ status: "error" }, ({ requestId, code, httpStatus }) => {
      if (code === "invalid_response") throw new PublicError("The server returned an invalid launch step.", { code });
      throw new PublicError("The launch step couldn’t load.", { code: code ?? "invalid_response", httpStatus, requestId });
    })
    .exhaustive();
  const planned = plan.steps[0]!;
  if (plan.draft_id !== input.draftId || plan.version !== input.version || planned.kind !== step) {
    throw new PublicError("The server returned an invalid launch step.", { code: "invalid_response" });
  }
  const transaction = Transaction.from(planned.transaction);
  if (transaction.getData().sender !== input.creator) throw new PublicError("The launching wallet changed. Sign in with the original wallet.");
  if (!planned.sponsorship) throw new PublicError("Blast did not sponsor this step. Nothing was signed.");
  const kind = await transaction.build({ client: input.client, onlyTransactionKind: true });
  const bytes = readSponsoredBytes(planned.sponsorship.transaction_bytes, kind, input.creator);
  if (!bytes) throw new PublicError("The sponsor changed the launch transaction. Nothing was signed.");
  return { bytes: toBase64(bytes), digest: TransactionDataBuilder.getDigestFromBytes(bytes), reservationId: planned.sponsorship.reservation_id, package: plan.launchpad_original_package_id, corePackage: plan.core_original_package_id };
}

function loadProgress(input: LaunchPublishInput): Checkpoint {
  const raw = input.storage.getItem(launchProgressKey(input.draftId, input.creator));
  if (!raw) return { version: input.version, transactions: {} };
  return readPublishProgress(raw, checkpointSchema, input.version, {
    invalid: "Saved launch progress is invalid. Keep this draft and contact support.",
    changed: "This draft changed after launching started. Resume the original saved settings.",
  });
}

function saveProgress(input: LaunchPublishInput, checkpoint: Checkpoint): void {
  // Only bytes and digests persist; wallet keys and signatures never do.
  input.storage.setItem(launchProgressKey(input.draftId, input.creator), JSON.stringify(checkpoint));
}
