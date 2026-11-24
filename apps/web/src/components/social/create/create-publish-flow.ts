import { PublicError } from "#web/lib/errors.ts";
import { readCurrencyRegistration } from "@interest-protocol/blast-sdk";
import { BLAST_DEPLOYMENTS, deploymentFingerprint, evaluateProtocolAccess, observeDeploymentRuntime } from "@interest-protocol/blast-sdk/deployments";
import { PRESALE_PAUSE_BITS, readPresaleCoinPublication } from "@interest-protocol/blast-sdk/presale";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeStructTag, toBase64 } from "@mysten/sui/utils";
import { match } from "ts-pattern";
import { z } from "zod";

import { presaleAbortMessage, presaleExecutionMessage } from "@blast/core/modules/presale/abort-messages.ts";
import { CREATE_PUBLISH_BLOCKERS, savedPublishPackageSchema, type CreatePublishStep } from "@blast/core/web/contracts/create.ts";
import { readSponsoredBytes } from "#web/lib/sui-signing.ts";
import { findPublishedCurrency, findTransaction, readPublishProgress, savedTransactionFields, sendPublishTransaction, type ConfirmedTransaction, type PublishSigner, type TransactionResult } from "#web/components/social/publish-transaction.ts";
import { recordPublished, requestPublish, type CreateApiOptions } from "./create-client.ts";
import { publishOffLine } from "./create-review-model.ts";
import { isEmptyPublishCheckpoint, publishStorageKey } from "./create-publish-storage.ts";

type PublishStep = CreatePublishStep["kind"];
type PublishStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const savedTransactionSchema = z.strictObject({
  ...savedTransactionFields,
  presale_package: savedPublishPackageSchema.optional(),
});
const checkpointSchema = z.strictObject({
  version: z.number().int().positive(),
  transactions: z.strictObject({
    publish_coin: savedTransactionSchema.optional(),
    register_currency: savedTransactionSchema.optional(),
    create_presale: savedTransactionSchema.optional(),
  }),
});
type SavedTransaction = z.infer<typeof savedTransactionSchema>;
type PublishCheckpoint = z.infer<typeof checkpointSchema>;
type PublishedCoin = ReturnType<typeof readPresaleCoinPublication>;

type PublishInput = Readonly<{
  api: CreateApiOptions;
  client: ClientWithCoreApi;
  storage: PublishStorage;
  draftId: string;
  version: number;
  creator: string;
  fee: PublishSigner["fee"];
  sign: PublishSigner["sign"];
  progress(message: string): void;
  onConfirmed?(step: PublishStep, digest: string): void;
}>;

/** Each transaction is saved before broadcasting; retries reuse its digest. */
export async function publishPresale(input: PublishInput): Promise<string> {
  const checkpoint = loadPublishProgress(input);
  const publication = await confirmPublishStep(input, checkpoint, "publish_coin");
  const core = checkpoint.transactions.publish_coin?.presale_package?.core_original_package_id;
  if (!core) throw new PublicError("This coin belongs to an earlier deployment.");
  const coin = readPresaleCoinPublication(publication, { core: { originalPackageId: core } });
  if (coin.sealedTreasuryCap.owner !== input.creator) throw new PublicError("The publication did not deliver the sealed treasury cap to your wallet.");

  const currency = await ensureCurrencyRegistration(input, checkpoint, coin);
  const { objectId, version, digest } = coin.sealedTreasuryCap;

  const presale = await confirmPublishStep(input, checkpoint, "create_presale", {
    coin_type: coin.saleTokenType,
    sealed_treasury_cap: { object_id: objectId, version, digest },
    currency,
  });
  const originalPackageId = checkpoint.transactions.create_presale?.presale_package?.original_package_id;
  const presaleType = `${originalPackageId}::blast_presale::Presale<${coin.saleTokenType},`;
  const presaleId = requireCreatedObject(presale, (type) =>
    normalizeStructTag(type).startsWith(presaleType),
  );

  input.api.signal?.throwIfAborted();
  input.progress("4 of 4 · Finalizing coin");
  const recorded = await recordPublished(input.api, input.draftId, presaleId);
  if (recorded.status !== "ok") {
    throw new PublicError(
      "Your presale is on-chain. Its cover and links couldn’t save yet; retry to finish without publishing again.", recorded,
    );
  }

  try {
    input.storage.removeItem(publishStorageKey(input.draftId, input.creator));
  } catch {
    // Publication is already recorded; storage cleanup cannot undo it.
  }
  return presaleId;
}

async function ensureCurrencyRegistration(
  input: PublishInput,
  checkpoint: PublishCheckpoint,
  coin: PublishedCoin,
) {
  input.api.signal?.throwIfAborted();
  input.progress(stepLabel("register_currency"));
  let registered = await findPublishedCurrency(input, coin.saleTokenType, checkpoint.transactions.register_currency);
  if (!registered) {
    try {
      const registration = await confirmPublishStep(input, checkpoint, "register_currency", {
        coin_type: coin.saleTokenType,
        currency: { object_id: coin.pendingCurrency.objectId, version: coin.pendingCurrency.version, digest: coin.pendingCurrency.digest },
      });
      const shared = readCurrencyRegistration(registration, coin.saleTokenType);
      return { object_id: shared.objectId, initial_shared_version: String(shared.initialSharedVersion) };
    } catch (error) {
      input.api.signal?.throwIfAborted();
      // Registration is permissionless; another transaction may have consumed the pending currency.
      registered = await findPublishedCurrency(input, coin.saleTokenType, checkpoint.transactions.register_currency);
      if (!registered) throw error;
    }
  }
  return {
    object_id: registered.objectId,
    initial_shared_version: registered.initialSharedVersion,
  };
}

async function confirmPublishStep(
  input: PublishInput,
  checkpoint: PublishCheckpoint,
  step: PublishStep,
  coin?: Readonly<Record<string, unknown>>,
): Promise<ConfirmedTransaction> {
  input.api.signal?.throwIfAborted();
  input.progress(stepLabel(step));

  const saved = checkpoint.transactions[step];
  const existing = saved ? await findTransaction(input.client, saved.digest) : null;
  const result = existing ?? (await signAndSubmit(input, checkpoint, step, saved, coin));

  return match(result)
    .with({ $kind: "Transaction" }, ({ Transaction: transaction }) => {
      input.onConfirmed?.(step, transaction.digest);
      return transaction;
    })
    .with({ $kind: "FailedTransaction" }, ({ FailedTransaction: transaction }) => {
      const message = presaleExecutionMessage(transaction.effects?.status.error, checkpoint.transactions[step]?.presale_package);
      delete checkpoint.transactions[step];
      savePublishProgress(input, checkpoint);
      throw new PublicError(
        message ?? `${stepLabel(step)} failed on-chain.`,
      );
    })
    .exhaustive();
}

async function signAndSubmit(
  input: PublishInput,
  checkpoint: PublishCheckpoint,
  step: PublishStep,
  saved: SavedTransaction | undefined,
  coin: Readonly<Record<string, unknown>> | undefined,
): Promise<TransactionResult> {
  const prepared = saved ?? (await prepareTransaction(input, step, coin));
  await verifySigningDeployment(input.client, prepared);
  input.api.signal?.throwIfAborted();

  return sendPublishTransaction(input, prepared, {
    cancelled: "Publishing was cancelled in your wallet.",
    unconfirmed: "Blast could not confirm this publishing step.",
    keep: () => {
      checkpoint.transactions[step] = prepared;
      savePublishProgress(input, checkpoint);
    },
    drop: () => {
      delete checkpoint.transactions[step];
      savePublishProgress(input, checkpoint);
    },
  });
}

async function verifySigningDeployment(client: ClientWithCoreApi, transaction: SavedTransaction) {
  const identity = transaction.presale_package;
  const message = "The presale deployment could not be verified.";
  if (!identity?.core_original_package_id) throw new PublicError(message);
  if (!identity.deployment_fingerprint) return;
  const manifest = BLAST_DEPLOYMENTS.mainnet;
  if (!manifest || identity.deployment_fingerprint !== deploymentFingerprint(manifest) ||
      identity.package_id !== manifest.packages.presale.packageId ||
      identity.original_package_id !== manifest.packages.presale.originalPackageId ||
      identity.core_original_package_id !== manifest.packages.core.originalPackageId || !identity.venue) {
    throw new PublicError(message);
  }
  const runtime = await observeDeploymentRuntime(client, manifest).catch(() => null);
  const access = evaluateProtocolAccess({ manifest, mode: "production", runtime: runtime ?? undefined });
  if (access.signing !== "enabled" || !access.venues[identity.venue].available || (access.paused.presale & PRESALE_PAUSE_BITS.Create) !== 0) {
    throw new PublicError(message);
  }
}

async function prepareTransaction(
  input: PublishInput,
  step: PublishStep,
  coin: Readonly<Record<string, unknown>> | undefined,
): Promise<SavedTransaction> {
  const response = await requestPublish(
    input.api,
    input.draftId,
    input.version,
    input.creator,
    step,
    coin,
    input.fee,
  );
  const plan = match(response)
    .with({ status: "ok" }, ({ body }) => body)
    .with({ status: "error", code: "invalid_response", httpStatus: 200 }, ({ requestId }) => {
      throw new PublicError("The server returned an invalid publish plan.", { code: "invalid_response", requestId });
    })
    .with({ status: "refused" }, ({ code, error, requestId }) => {
      const refuse = (message: string): never => {
        throw new PublicError(message, { code, requestId, reason: error.reason });
      };
      const contract = presaleAbortMessage(error.contract_error) ?? presaleAbortMessage(error.move_abort);
      if (contract) refuse(contract);
      if (error.reason === "minimum_raise") {
        const issue = z.object({ section: z.literal("raise"), path: z.literal("target"), message: z.string() })
          .safeParse(Array.isArray(error.issues) ? error.issues[0] : undefined);
        if (issue.success) refuse(issue.data.message);
      }
      if (code === "publish_unavailable") {
        const reasons = CREATE_PUBLISH_BLOCKERS.filter((reason) => Array.isArray(error.reasons) && error.reasons.includes(reason));
        refuse(publishOffLine(reasons, false));
      }
      if (code === "draft_published") refuse("This presale is already published. Return to Create to start a new one.");
      if (code === "rate_limited" || code === "budget_exceeded") {
        const message = error.reason === "daily_limit"
          ? "You’ve reached the daily limit for Blast-paid network fees. Try again after 00:00 UTC."
          : error.reason === "open_reservations"
            ? "You have pending sponsored transactions. Wait a few minutes, then retry."
            : "Blast-paid network fees are temporarily limited. Try again later.";
        refuse(message);
      }
      if (code === "service_unavailable") refuse("Publishing is temporarily unavailable. Retry in a few minutes.");
      return refuse("Publishing was refused.");
    })
    .with({ status: "error" }, ({ requestId, code, httpStatus }) => {
      throw new PublicError("The publish plan couldn’t load.", { code: code ?? "invalid_response", httpStatus, requestId });
    })
    .exhaustive();

  const planned = plan.steps[0];
  if (
    plan.draft_id !== input.draftId ||
    plan.version !== input.version ||
    plan.steps.length !== 1 ||
    planned?.kind !== step ||
    !planned.transaction
  ) {
    throw new PublicError("The server returned an invalid publish plan.", { code: "invalid_response" });
  }

  const transaction = Transaction.from(planned.transaction);
  if (transaction.getData().sender !== input.creator) {
    throw new PublicError("The publish wallet changed. Sign in with the original wallet.");
  }
  if (!planned.sponsorship) throw new PublicError("Blast did not sponsor this publishing step. Nothing was signed.");
  const kind = await transaction.build({ client: input.client, onlyTransactionKind: true });
  const bytes = readSponsoredBytes(planned.sponsorship.transaction_bytes, kind, input.creator);
  if (!bytes) throw new PublicError("The sponsor changed the publishing transaction. Nothing was signed.");
  return { bytes: toBase64(bytes), digest: TransactionDataBuilder.getDigestFromBytes(bytes), reservationId: planned.sponsorship.reservation_id, presale_package: planned.presale_package };
}

function requireCreatedObject(
  transaction: ConfirmedTransaction,
  matches: (type: string) => boolean,
): string {
  const objects = transaction.effects.changedObjects.filter((object) => {
    const type = transaction.objectTypes[object.objectId];
    return object.idOperation === "Created" && type && type !== "package" && matches(type);
  });
  const object = objects[0];
  if (objects.length !== 1 || !object) {
    throw new PublicError(
      "The confirmed transaction did not return the expected object.",
    );
  }
  return object.objectId;
}

function stepLabel(step: PublishStep): string {
  return match(step)
    .with("publish_coin", () => "1 of 4 · Publish coin")
    .with("register_currency", () => "2 of 4 · Register currency")
    .with("create_presale", () => "3 of 4 · Create presale")
    .exhaustive();
}

function loadPublishProgress(input: PublishInput): PublishCheckpoint {
  const key = publishStorageKey(input.draftId, input.creator);
  const raw = input.storage.getItem(key);
  if (!raw) {
    return { version: input.version, transactions: {} };
  }
  if (isEmptyPublishCheckpoint(raw)) {
    input.storage.removeItem(key);
    return { version: input.version, transactions: {} };
  }

  return readPublishProgress(raw, checkpointSchema, input.version, {
    invalid: "Saved publish progress is invalid. Keep this draft and contact support.",
    changed: "This draft changed after publishing started. Resume the original saved terms.",
  });
}

function savePublishProgress(input: PublishInput, checkpoint: PublishCheckpoint): void {
  const key = publishStorageKey(input.draftId, input.creator);
  if (Object.keys(checkpoint.transactions).length === 0) {
    input.storage.removeItem(key);
    return;
  }
  // Only bytes and digests persist; wallet keys and signatures never do.
  input.storage.setItem(key, JSON.stringify(checkpoint));
}
