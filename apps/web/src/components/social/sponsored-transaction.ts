import type { ClientWithCoreApi } from "@mysten/sui/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import type { SponsorRequest } from "@blast/core/modules/presale/contracts/sponsor-request.ts";
import {
  executedSponsoredSchema,
  sponsoredTransactionSchema,
  type ExecutedSponsored,
  type SponsoredTransaction,
} from "@blast/core/modules/presale/contracts/transaction-responses.ts";
import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";
import { isSignatureRefusal, readSponsoredBytes, WalletChangedBytes } from "#web/lib/sui-signing.ts";

/**
 * The browser half of a chain write Blast sponsors: ask the sponsor, verify
 * its bytes, sign, execute, and wait for the server to see the result. Each
 * flow keeps its own record route and its own copy; the steps between live
 * here once.
 *
 * Every caller is sponsored (a Privy embedded wallet, and a wallet session
 * such as Slush, owner ruling 2026-11-20 reversing OA-17): the sponsor answers
 * full bytes; they are signed only when they are exactly the kind, from the
 * sender. A wallet session signs them through `sponsoredWalletSigner`
 * (`lib/sui-signing.ts`), which refuses any bytes the wallet changed. Only a
 * trade past the day's cap is paid by the wallet itself.
 *
 * Two flows run those steps themselves: a trade, whose bytes come whole from
 * the server, and a commit, which registers its intent before it signs. Both
 * use `signExactly`, then `sendSponsored` (a trade past the cap uses
 * `executeOnFullnode`); a trade then waits with `pollSettlement`. A sponsored launchpad action signs with
 * its own signer, then sends with `sendSponsored`; an unsponsored one executes
 * on the fullnode itself. Publishing a coin keeps its own steps in
 * `publish-transaction.ts`, and vesting keeps its own refusal rules.
 */

export type { SponsoredTransaction };

export type ApiRefusal = Exclude<ApiResult<unknown>, { status: "ok" }>;

/** The Blast wallet's signer. Both arms sign only; the flow executes. */
export type TransactionSigner =
  | Readonly<{
    fee: "sponsored";
    address: string;
    /** Signs exactly these bytes with the embedded key; the serialized signature. */
    signTransaction(bytes: Uint8Array): Promise<string>;
  }>
  | Readonly<{
    fee: "wallet";
    address: string;
    /** Signs exactly these bytes in the wallet, and executes nothing. */
    signTransaction(bytes: Uint8Array): Promise<Readonly<{ bytes: string; signature: string }>>;
  }>;

/** The signer every sponsored flow takes: it answers only the signature over the exact bytes. */
export type SponsoredSigner = Extract<TransactionSigner, { fee: "sponsored" }>;

/** Waits between settlement reads while the fullnode does not show a sent transaction yet. */
export const SETTLE_DELAYS_MS = [800, 1_500, 2_500, 4_000] as const;

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMainnetClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: "mainnet", baseUrl: SUI_MAINNET_GRPC_URL });
}

export function requestSponsorship(options: SocialApiOptions, request: SponsorRequest): Promise<ApiResult<SponsoredTransaction>> {
  return callSocialApi(options, "/api/presale/sponsor", { method: "POST", body: request }, sponsoredTransactionSchema);
}

export function executeSponsored(options: SocialApiOptions, reservationId: string, userSignature: string): Promise<ApiResult<ExecutedSponsored>> {
  return callSocialApi(
    options,
    `/api/presale/sponsor/${encodeURIComponent(reservationId)}/execute`,
    { method: "POST", body: { user_signature: userSignature } },
    executedSponsoredSchema,
  );
}

/** Why nothing was signed; `error` is what the build or the signer threw. */
export type Unsigned = Readonly<{ status: "unsigned"; reason: "mismatch" | "rejected" | "sign_failed"; error?: unknown }>;

/** The sponsor refused before submitting: nothing reached Sui. */
type SponsorRefusal = Extract<ApiRefusal, { status: "refused" }>;

/**
 * Submitted, or possibly submitted: `unknown` means it may be on Sui. Only a
 * sponsor answer that executed (`success` or `failure`) carries `digest`.
 */
type Executed = Readonly<{ status: "executed"; executed: "success" | "failure" | "unknown"; requestId?: string; digest?: string }>;

export type Sent = Executed | Readonly<{ status: "refused"; refusal: SponsorRefusal }>;

/** A signature over exactly the bytes asked for. */
type ExactSignature = Readonly<{ status: "signed"; signature: string }>;

/** Signed bytes, not sent yet: the flow records the digest (or checks a deadline) before `send`. */
export type Signed = Readonly<{ status: "signed"; bytes: Uint8Array; digest: string; send: () => Promise<Sent> }>;

type SponsoredSigning = Readonly<{
  api: SocialApiOptions;
  sponsorship: SponsoredTransaction;
  kind: Uint8Array;
  signer: SponsoredSigner;
  signal?: AbortSignal;
}>;

/** Signs the sponsor's bytes when they are exactly `kind` from the signer; `send` executes them through the sponsor. */
export async function signSponsored({ api, sponsorship, kind, signer, signal }: SponsoredSigning): Promise<Signed | Unsigned> {
  const bytes = readSponsoredBytes(sponsorship.transaction_bytes, kind, signer.address);
  if (bytes === null) {
    return unsigned("mismatch");
  }

  const signed = await signExactly(signer, bytes, signal);
  if (signed.status === "unsigned") {
    return signed;
  }

  return {
    status: "signed",
    bytes,
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    send: () => sendSponsored(api, sponsorship.reservation_id, signed.signature),
  };
}

/**
 * Has the signer sign exactly `bytes`. A wallet answers the bytes it signed;
 * when it rebuilt them, nothing may go out.
 */
export async function signExactly(signer: TransactionSigner, bytes: Uint8Array, signal?: AbortSignal): Promise<ExactSignature | Unsigned> {
  if (signal?.aborted) {
    return unsigned("rejected");
  }

  let signed: Readonly<{ bytes: string; signature: string }>;
  try {
    if (signer.fee === "sponsored") {
      return { status: "signed", signature: await signer.signTransaction(bytes) };
    }

    signed = await signer.signTransaction(bytes);
  } catch (error) {
    return declined(error);
  }

  return signed.bytes === toBase64(bytes) ? { status: "signed", signature: signed.signature } : unsigned("mismatch");
}

/** Waits before sending a signed reservation again after a busy 503: the server or its gas pool had no room. */
export const BUSY_RESEND_DELAYS_MS = [1_000, 2_000] as const;

/**
 * Executes through the sponsor. A refusal before submission (an expired
 * reservation, a refused signature) is final; anything else — a 5xx, a lost
 * reply, `execution_unconfirmed` — may have reached Sui, so it is `unknown`.
 * An executed answer carries the digest the sponsor ran.
 *
 * A busy 503 (the backend's lane or the gas pool had no room, nothing was
 * submitted) is sent again, twice at most, with the same signature: the
 * server submits one reservation at most once, so a repeat either submits it
 * now or answers what the first call did. Any other answer is final here.
 */
function isBusy(answer: ApiResult<unknown>): boolean {
  return answer.status !== "ok" && answer.httpStatus === 503 && (answer.code === "busy" || answer.code === "service_unavailable");
}

export async function sendSponsored(api: SocialApiOptions, reservationId: string, signature: string): Promise<Sent> {
  let answer = await executeSponsored(api, reservationId, signature);
  for (const delayMs of BUSY_RESEND_DELAYS_MS) {
    if (!isBusy(answer) || api.signal?.aborted) break;
    await sleepFor(delayMs + Math.floor(Math.random() * 500));
    answer = await executeSponsored(api, reservationId, signature);
  }
  if (answer.status === "ok") {
    return { status: "executed", executed: answer.body.effects.status === "success" ? "success" : "failure", digest: answer.body.digest };
  }

  if (answer.status === "refused" && answer.code !== "execution_unconfirmed" && (answer.httpStatus ?? 500) < 500) {
    return { status: "refused", refusal: answer };
  }

  return { status: "executed", executed: "unknown", ...(answer.requestId ? { requestId: answer.requestId } : {}) };
}

/** Executes signed bytes on the fullnode; a throw may follow a send, so it is `unknown`. */
export async function executeOnFullnode(client: ClientWithCoreApi, bytes: Uint8Array, signature: string): Promise<Executed> {
  try {
    const answer = await client.core.executeTransaction({ transaction: bytes, signatures: [signature] });
    return { status: "executed", executed: answer.$kind === "Transaction" ? "success" : "failure" };
  } catch {
    return { status: "executed", executed: "unknown" };
  }
}

/**
 * Reads a sent transaction's record until it is no longer pending or the
 * waits run out; null when the record cannot be read.
 */
export async function pollSettlement<Settled>(
  read: () => Promise<ApiResult<Settled>>,
  isPending: (settled: Settled) => boolean,
): Promise<Settled | null> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await read();
    if (result.status !== "ok") {
      return null;
    }

    if (!isPending(result.body) || attempt >= SETTLE_DELAYS_MS.length) {
      return result.body;
    }

    await sleepFor(SETTLE_DELAYS_MS[attempt]!);
  }
}

function unsigned(reason: Unsigned["reason"], error?: unknown): Unsigned {
  return error === undefined ? { status: "unsigned", reason } : { status: "unsigned", reason, error };
}

function declined(error: unknown): Unsigned {
  // The error stays, so a flow can tell a wallet that changed the bytes from a sponsor that did.
  if (error instanceof WalletChangedBytes) return unsigned("mismatch", error);
  return unsigned(isSignatureRefusal(error) ? "rejected" : "sign_failed", error);
}
