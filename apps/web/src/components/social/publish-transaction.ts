import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { z } from "zod";

import { findCurrencyRegistration } from "#web/components/launchpad/launch/chain-facts.ts";
import { isWalletRejection } from "#web/components/sign-in/wallet-sign-in-client.ts";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import { executeSponsored } from "#web/components/social/sponsored-transaction.ts";
import { PublicError } from "#web/lib/errors.ts";

/**
 * The steps a coin's publication repeats for each of its transactions
 * (publish the coin, register its currency, create the presale or the
 * launch). Each transaction is saved before it is broadcast, and a retry
 * finds it by digest, so a closed tab or a lost answer never sends a step
 * twice. Create and launch publishing share them.
 *
 * Blast pays every step's gas, for an embedded wallet and a wallet session
 * alike (owner ruling 2026-11-20). They do not use `signExactly` and
 * `sendSponsored`: publishing reads a wallet's refusal with
 * `isWalletRejection`, compares the signed bytes itself, and keeps the
 * sponsor's code and reference on its error.
 */

const PUBLISH_TRANSACTION_DETAILS = { effects: true, objectTypes: true } as const;
export type ConfirmedTransaction = SuiClientTypes.Transaction<typeof PUBLISH_TRANSACTION_DETAILS>;
export type TransactionResult = SuiClientTypes.TransactionResult<typeof PUBLISH_TRANSACTION_DETAILS>;

/** The creator's wallet; Blast pays its gas. */
export type PublishSigner = Readonly<{
  address: string;
  fee: "sponsored";
  /** Signs `bytes`; answers the bytes it signed with the signature. */
  sign(bytes: Uint8Array): Promise<Readonly<{ bytes: string; signature: string }>>;
}>;

/** A step's transaction as saved before it is signed; `reservationId` is the sponsor's (absent only in progress saved before every step was sponsored). */
export const savedTransactionFields = {
  bytes: z.string().min(1),
  digest: z.string().min(1),
  reservationId: z.string().uuid().optional(),
} as const;

type SavedTransaction = Readonly<{ bytes: string; digest: string; reservationId?: string }>;
type SavedProgress = Readonly<{ version: number; transactions: Readonly<Record<string, SavedTransaction | undefined>> }>;

/** The errors for saved progress that cannot be read, and for a draft that changed since. */
type ProgressWords = Readonly<{ invalid: string; changed: string }>;
/** The flow's own words, and how it saves or drops the step in its checkpoint. */
type PublishSendOptions = Readonly<{
  /** The error when the wallet refused to sign. */
  cancelled: string;
  /** The error when the sponsor could not confirm the send. */
  unconfirmed: string;
  /** Saves the transaction to the checkpoint once its signature is exact. */
  keep(): void;
  /** Drops it from the checkpoint when its reservation expired. */
  drop(): void;
}>;

/** The flow's client, API and signer. */
type PublishSend = Readonly<{
  api: SocialApiOptions;
  client: ClientWithCoreApi;
  sign: PublishSigner["sign"];
}>;

/** Reads a draft's saved progress; every saved digest must match its bytes. */
export function readPublishProgress<Progress extends SavedProgress>(
  raw: string,
  schema: z.ZodType<Progress>,
  version: number,
  words: ProgressWords,
): Progress {
  let progress: Progress;
  try {
    progress = schema.parse(JSON.parse(raw));
    for (const saved of Object.values(progress.transactions)) {
      if (saved && TransactionDataBuilder.getDigestFromBytes(fromBase64(saved.bytes)) !== saved.digest) {
        throw new Error("digest");
      }
    }
  } catch {
    throw new PublicError(words.invalid, { code: "publish_progress_invalid" });
  }
  if (progress.version !== version) {
    throw new PublicError(words.changed);
  }

  return progress;
}

/** The transaction by digest, or null when Sui has not seen it. */
export async function findTransaction(client: ClientWithCoreApi, digest: string): Promise<TransactionResult | null> {
  try {
    return await client.core.getTransaction({ digest, include: PUBLISH_TRANSACTION_DETAILS });
  } catch (error) {
    if (error instanceof TransactionError && error.reason === "notFound") {
      return null;
    }
    throw error;
  }
}

/** Anyone can register the currency. Only the creator’s own successful digest earns a toast. */
export async function findPublishedCurrency(
  input: Readonly<{ client: ClientWithCoreApi; onConfirmed?(step: "register_currency", digest: string): void }>,
  coinType: string,
  saved: SavedTransaction | undefined,
) {
  const currency = await findCurrencyRegistration(input.client, coinType);
  if (currency && saved && input.onConfirmed) {
    // A missing receipt cannot stop publishing once the registry confirms the currency.
    const receipt = await findTransaction(input.client, saved.digest).catch(() => null);
    if (receipt?.$kind === "Transaction" && receipt.Transaction.digest === saved.digest) {
      input.onConfirmed("register_currency", saved.digest);
    }
  }
  return currency;
}

/**
 * Signs the saved transaction and, once the wallet signed exactly its bytes,
 * keeps it and sends it through the sponsor, then waits for Sui. An expired reservation
 * drops it, so the next try asks for a fresh one.
 */
export async function sendPublishTransaction(input: PublishSend, prepared: SavedTransaction, options: PublishSendOptions): Promise<TransactionResult> {
  const reservationId = requireReservation(prepared);
  const signed = await input.sign(fromBase64(prepared.bytes)).catch((error: unknown) => {
    const rejected = isWalletRejection(error);
    throw new PublicError(rejected ? options.cancelled : "Your wallet could not sign. Reconnect it and retry.", { code: rejected ? "wallet_rejected" : "sign_failed" });
  });
  if (signed.bytes !== prepared.bytes) {
    throw new PublicError("The wallet changed the transaction. Nothing was sent.");
  }

  input.api.signal?.throwIfAborted();
  options.keep();

  // The sponsor route owns its deadline. A page closing cannot cancel a submitted step.
  const executed = await executeSponsored({ ...input.api, signal: undefined }, reservationId, signed.signature);
  if (executed.status !== "ok") {
    if (executed.status === "refused" && executed.code === "reservation_expired") {
      options.drop();
    }
    // A server error can be the relay reporting a lost upstream reply after execution.
    const ambiguousReply = executed.status === "error" || executed.code === "execution_unconfirmed" || (executed.httpStatus ?? 0) >= 500;
    if (input.api.signal?.aborted && ambiguousReply) {
      // The next step cannot start, but a lost reply can still have a successful receipt.
      const receipt = await findTransaction(input.client, prepared.digest).catch(() => null);
      if (receipt?.$kind === "Transaction" && receipt.Transaction.digest === prepared.digest) return receipt;
      input.api.signal.throwIfAborted();
    }
    throw new PublicError(options.unconfirmed, executed);
  }
  if (executed.body.digest !== prepared.digest) {
    throw new PublicError("The sponsor returned a different transaction digest. Keep this draft and contact support.");
  }

  return input.client.core.waitForTransaction({ digest: prepared.digest, include: PUBLISH_TRANSACTION_DETAILS });
}

function requireReservation(prepared: SavedTransaction): string {
  if (!prepared.reservationId) {
    throw new PublicError("Saved progress uses wallet gas. Keep this draft and contact support.");
  }
  return prepared.reservationId;
}
