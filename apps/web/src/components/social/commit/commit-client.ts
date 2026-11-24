import { socialCommitSaleReadSchema } from "@blast/core/web/contracts/commit-sale.ts";
import { socialPresaleViewerResponseSchema } from "@blast/core/web/contracts/presale-schemas.ts";
import { allowlistProofResponseSchema, type AllowlistLeaf } from "@blast/core/modules/presale/contracts/transaction-responses.ts";
import {
  socialCommitBuildSchema,
  SOCIAL_COMMITS_PATH,
  type SocialCommitBuild,
  type SocialCommitRequest,
} from "@blast/core/web/contracts/commit.ts";
import {
  INTENT_REGISTER_TIMEOUT_MS,
  SOCIAL_INTENTS_PATH,
  socialIntentRecordedSchema,
  type SocialIntentRecorded,
} from "@blast/core/web/contracts/intents.ts";

import {
  PRESALE_COMMIT_FIELDS_HEADER,
  SOCIAL_PRESALE_VIEWER_PATH,
  SOCIAL_PRESALES_PATH,
  type SocialPresaleViewerEntry,
} from "@blast/core/web/contracts/presales.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";
import type { CommitSaleRead } from "./commit-view";

/**
 * The commit dialog's calls, all through the shared session helper
 * (`callSocialApi`: the Privy token, or the wallet session cookie — OA-16, so
 * no Authorization header is ever built here):
 *
 * - `POST /api/social/me/commits`: the commit, built on the server (which
 *   holds the presale deployment) for the Blast wallet to sign;
 * - `POST /api/social/intents` (T-024), after the digest and before execute;
 * - `GET /api/presale/presales/{id}/proof?wallet=` (the allowlist leaf);
 * - `POST /api/social/presales/viewer` (the viewer's own position, for the
 *   wallet cap).
 */

export type IntentRequest = Readonly<{
  presaleId: string;
  digest: string;
  transactionBytes?: string;
  sourceEntryId?: string | null;
  why?: string | null;
  /** The commit's transaction-log facts (R3-27): its coin (normalised), atoms in it, and dollars at submission. */
  log?: CommitLogFacts | null;
}>;

export type CommitLogFacts = Readonly<{ quoteType: string; quoteAmount: string; usdValue: string | null }>;

/** Registers one intent. Its own failure is the caller's to ignore (AC-096). */
export function registerIntent(options: SocialApiOptions, request: IntentRequest): Promise<ApiResult<SocialIntentRecorded>> {
  return callSocialApi(
    options,
    SOCIAL_INTENTS_PATH,
    {
      method: "POST",
      body: {
        action: "commit",
        presale_id: request.presaleId,
        tx_digest: request.digest,
        ...(request.transactionBytes ? { transaction_bytes: request.transactionBytes } : {}),
        ...(request.sourceEntryId ? { source_entry_id: request.sourceEntryId } : {}),
        ...(request.why ? { why: request.why } : {}),
        ...(request.log ? { quote_type: request.log.quoteType, quote_amount: request.log.quoteAmount } : {}),
        ...(request.log?.usdValue ? { usd_value: request.log.usdValue } : {}),
      },
    },
    socialIntentRecordedSchema,
  );
}

/**
 * Registers an intent with a hard ceiling on how long the commit waits for it
 * (AC-096). The transaction is signed by the time this runs, so **nothing**
 * this returns may stop the execute: a timeout, a network failure, a refusal
 * and a thrown error are all the same answer, `null`.
 *
 * The call itself is not cancelled on a timeout: the server may well be about
 * to record the intent, and abandoning the request would lose an attribution
 * that was already on its way. Only the wait is bounded.
 */
export async function registerIntentWithin(
  options: SocialApiOptions,
  request: IntentRequest,
): Promise<SocialIntentRecorded | null> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = Symbol("gave up");
  try {
    const raced = await Promise.race([
      registerIntent(options, request).then(
        (result) => result,
        () => null,
      ),
      new Promise<typeof gaveUp>((resolve) => {
        handle = setTimeout(() => resolve(gaveUp), INTENT_REGISTER_TIMEOUT_MS);
      }),
    ]);
    if (raced === gaveUp || raced === null) return null;
    return raced.status === "ok" ? raced.body : null;
  } finally {
    clearTimeout(handle);
  }
}

/** Whether `value` is a well-formed built commit (everything the flow reads). */
export function isSocialCommitBuild(value: unknown): value is SocialCommitBuild {
  return socialCommitBuildSchema.safeParse(value).success;
}

/**
 * The commit, built by the server for the Blast wallet: the browser has no
 * deployment to build it against, so it asks, then signs what comes back.
 */
export function requestCommitBuild(options: SocialApiOptions, body: SocialCommitRequest): Promise<ApiResult<SocialCommitBuild>> {
  return callSocialApi(options, SOCIAL_COMMITS_PATH, { method: "POST", body }, socialCommitBuildSchema);
}

export type { AllowlistLeaf };

/**
 * A wallet's allowlist leaf for a sale. `not_eligible` means the wallet is not
 * on it — the dialog's own state, not a failure.
 */
export function fetchAllowlistLeaf(options: SocialApiOptions, presaleId: string, wallet: string): Promise<ApiResult<AllowlistLeaf>> {
  return callSocialApi(
    options,
    `/api/presale/presales/${encodeURIComponent(presaleId)}/proof?wallet=${encodeURIComponent(wallet)}`,
    { method: "GET" },
    allowlistProofResponseSchema,
  );
}

export function isCommitSaleRead(value: unknown): value is CommitSaleRead {
  return socialCommitSaleReadSchema.safeParse(value).success;
}

/** One sale, as the dialogs read it. Public, so a visitor's sale dialog works too. */
export function fetchCommitSale(options: SocialApiOptions, presaleId: string): Promise<ApiResult<CommitSaleRead>> {
  return callSocialApi(options, `${SOCIAL_PRESALES_PATH}/${encodeURIComponent(presaleId)}`, { method: "GET", headers: { [PRESALE_COMMIT_FIELDS_HEADER]: "1" } }, socialCommitSaleReadSchema);
}

/**
 * The viewer's own position in one sale, or null when they never committed:
 * what they already hold counts against the wallet cap. It is the sale page's
 * own personal read (`POST /api/social/presales/viewer`, account required,
 * never cached), so the dialog adds no query of its own.
 */
export async function fetchViewerEntry(
  options: SocialApiOptions,
  presaleId: string,
): Promise<ApiResult<SocialPresaleViewerEntry | null>> {
  const read = await callSocialApi(options, SOCIAL_PRESALE_VIEWER_PATH, { method: "POST", body: { presale_ids: [presaleId] }, headers: { [PRESALE_COMMIT_FIELDS_HEADER]: "1" } }, socialPresaleViewerResponseSchema);
  if (read.status !== "ok") return read;
  return { status: "ok", httpStatus: read.httpStatus, body: read.body.presales[presaleId] ?? null };
}
