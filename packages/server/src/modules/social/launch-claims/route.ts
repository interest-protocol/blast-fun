import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_LAUNCH_CLAIM_PATH } from "@blast/core/modules/backend-api/private/social-claims-contracts.ts";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SponsorResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { launchClaimBindingFromKey, launchClaimIdempotencyKey } from "@blast/core/modules/social/claims/identity.ts";
import { claimsBinding } from "@blast/core/modules/social/claims/launch-events.ts";
import type { SocialClaimClientFailure } from "@blast/core/modules/social/contracts/claims.ts";
import type { SocialTransferFee } from "@blast/core/modules/social/contracts/coins.ts";
import { launchClaimInputSchema, LAUNCH_CLAIM_ROUTE, type LaunchClaim, type LaunchClaimKind } from "@blast/core/modules/social/contracts/launch-claims.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialCaller, SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  logTransaction,
  TRANSACTION_COLUMNS,
  TransactionLogConflict,
  type TransactionEntry,
  type TransactionProgress,
  type TransactionRow,
} from "@blast/core/modules/social/transactions/log.ts";
import { readDigestJson, verifyDigestProvenance } from "@blast/server/modules/social/transactions/digest-provenance.ts";
import type { SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import type { ExecutedLaunchClaim, LaunchClaimChain } from "./chain.ts";

/**
 * The launch claim route (LP-12; contract in `contracts/launch-claims.ts`):
 * `PUT /api/social/me/launch-claims/{request_id}`, in the presale claim route's order
 * (`../claims/route.ts`): **the attempt is in the account's transaction log before the wallet is
 * asked to sign**, then its digest before the transaction is executed, then its outcome. What may
 * be claimed is read from the chain here — the launch's live `CurveFeeCap` held by the Blast
 * wallet, and something unclaimed in that ledger — never taken from the client or the indexer.
 * Every claim is sponsored in-process before it is logged (a Privy embedded wallet's and an
 * outside wallet session's alike, owner ruling 2026-11-20), so a sponsor that cannot take it now
 * leaves nothing recorded. The row's `tx_id` is the request id; its key binds
 * the launch (and vault), so a replay cannot name another.
 */

export type LaunchClaimSponsorRequest = Readonly<{ caller: SponsorCaller; sender: string; kindBytes: Uint8Array; ip: string; signal: AbortSignal }>;

export type LaunchClaimRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary (an owner sees what they just did). Resolved per request. */
  database: () => ReadableDatabase;
  /** The released deployment's chain reads, or null while none is released: claiming is off. */
  chain: () => Promise<LaunchClaimChain | null>;
  /** The caller's Blast wallet: a Privy session's embedded Sui wallet (null until it exists), a wallet session's own address. */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  /** The presale sponsor's server-built `launch_claim`; throws its `PresaleRouteError`s. */
  sponsor: (request: LaunchClaimSponsorRequest) => Promise<SponsorResponse>;
  /** The launch's migration vault as blast-infra names it, or null for none; rejects while blast-infra cannot answer. */
  vaultOf: (launchId: string, signal: AbortSignal) => Promise<string | null>;
  /** Proves the caller's wallet signed a digest before it is reserved; replaceable in tests. */
  verifyProvenance?: typeof verifyDigestProvenance;
}>;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CLAIM_ROW_SQL = `SELECT ${TRANSACTION_COLUMNS} FROM social_transactions WHERE tx_id = $1::uuid`;

type ClaimInput = Readonly<{
  launchId: string;
  kind: LaunchClaimKind;
  digest: string | null;
  failure: SocialClaimClientFailure | null;
  /** The signed TransactionData, base64: proves the digest is the caller's before it is reserved. */
  transactionBytes?: unknown;
}>;

/** Blast's gas pool pays every caller's network fee: a Privy embedded wallet's and a wallet session's (owner ruling 2026-11-20). */
const CLAIM_FEE: SocialTransferFee = "sponsored";

function requestIdOf(request: Request): string {
  const segment = routeSegments(SOCIAL_LAUNCH_CLAIM_PATH, new URL(request.url).pathname)?.id ?? "";
  if (!REQUEST_ID.test(segment)) throw new SocialRouteError("invalid_parameter");
  return segment;
}

/** The closed body: a launch, a claim kind, and at most one of a digest or a failure. */
function parseClaim(body: Record<"launch_id" | "kind", unknown> & Partial<Record<"digest" | "failure" | "transaction_bytes", unknown>>): ClaimInput {
  const { launch_id: launchId, kind, digest, failure, transaction_bytes: transactionBytes } = socialInput(launchClaimInputSchema, body);
  return {
    launchId,
    kind,
    digest: digest ?? null,
    failure: failure ?? null,
    ...(transactionBytes !== undefined ? { transactionBytes } : {}),
  };
}

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

/** A stored attempt is this claim when it is of the same kind and its key binds the same launch. */
function sameClaim(row: TransactionRow, input: ClaimInput): boolean {
  return row.kind === input.kind && launchClaimBindingFromKey(row.kind, row.idempotency_key, row.tx_id)?.launchId === normalizeSuiAddress(input.launchId);
}

/** The log entry a stored attempt was recorded with, so a later call repeats its facts exactly. */
function entryOf(row: TransactionRow): TransactionEntry {
  return {
    accountId: row.account_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    txId: row.tx_id,
    presaleId: row.presale_id,
    coinType: row.coin_type,
    amount: row.amount,
    quoteType: row.quote_type,
    quoteAmount: row.quote_amount,
    usdValue: row.usd_value,
    createdAtMs: Number(row.created_at_ms),
  };
}

function claimBody(
  row: TransactionRow,
  input: ClaimInput,
  extra: Readonly<{ fee: SocialTransferFee; kindBytes?: Uint8Array | null; sponsored?: SponsorResponse | null }>,
): LaunchClaim {
  const open = row.state === "submitted" && row.digest === null;
  return {
    request_id: row.tx_id,
    launch_id: input.launchId,
    kind: input.kind,
    state: row.state,
    digest: row.digest,
    // The shared log also holds trade failures; claim writers only store claim failure codes.
    failure_code: row.failure_code as LaunchClaim["failure_code"],
    move_abort: null,
    fee: extra.fee,
    transaction_kind_bytes: open && extra.kindBytes ? toBase64(extra.kindBytes) : null,
    sponsored: open && extra.sponsored ? extra.sponsored : null,
    created_at_ms: Number(row.created_at_ms),
    settled_at_ms: row.settled_at_ms === null ? null : Number(row.settled_at_ms),
  };
}

/** Where a recorded claim stands once its digest executed: the wallet's own, successful transaction that made this claim. */
export function launchClaimVerdict(
  claim: Readonly<{ kind: LaunchClaimKind; launchId: string; vaultId: string | null; participant: string }>,
  executed: ExecutedLaunchClaim,
): Readonly<{ state: "confirmed" }> | Readonly<{ state: "failed"; failureCode: "execution_failed" | "mismatch" }> {
  if (normalizeSuiAddress(executed.sender) !== normalizeSuiAddress(claim.participant)) return { state: "failed", failureCode: "mismatch" };
  if (!executed.success) return { state: "failed", failureCode: "execution_failed" };
  return claimsBinding(executed.claims, claim.kind, claim) ? { state: "confirmed" } : { state: "failed", failureCode: "mismatch" };
}

/** A sponsor refusal in the route's own codes: its budgets are a rate limit, anything else is unavailable. */
function sponsorRefusal(error: unknown): never {
  if (!(error instanceof PresaleRouteError)) throw error;
  const limited = error.code === "budget_exceeded" || error.code === "rate_limited";
  throw new SocialRouteError(limited ? "rate_limited" : "service_unavailable", {
    extra: { reasons: ["sponsorship_unavailable"] },
    retryAfterSeconds: error.retryAfterSeconds ?? undefined,
  });
}

export function createLaunchClaimRoutes(dependencies: LaunchClaimRouteDependencies) {
  const { kit, database, chain, blastWallet, sponsor, vaultOf } = dependencies;

  const read = async (requestId: string): Promise<TransactionRow | null> =>
    (await database().read<TransactionRow>(CLAIM_ROW_SQL, [requestId])).rows[0] ?? null;

  /** Logs `progress` for the stored attempt; a row the worker settled first is answered as it now stands. */
  async function advance(context: SocialRequestContext, row: TransactionRow, progress: TransactionProgress): Promise<TransactionRow> {
    try {
      return await context.transaction(async (social) => (await logTransaction(social, entryOf(row), progress)).row, { label: "social.launch_claim" });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SocialRouteError("claim_conflict");
      if (!(error instanceof TransactionLogConflict)) throw error;
      if (error.reason !== "outcome") throw new SocialRouteError("claim_conflict");
      return (await read(row.tx_id)) ?? row;
    }
  }

  /** The claim the Blast wallet may make, as the chain shows it (a vault claim's vault from blast-infra), or `nothing_to_claim`. */
  async function claimable(reads: LaunchClaimChain, input: ClaimInput, participant: string, labels: Record<string, string>, signal: AbortSignal) {
    const vaultId = input.kind === "claim_launch_lp_fees" ? await vaultOf(input.launchId, signal) : null;
    const target = input.kind === "claim_launch_lp_fees" && vaultId === null
      ? null
      : await reads.target({ launchId: input.launchId, kind: input.kind, vaultId, participant }, { signal });
    if (target === null) {
      recordMetric("social.launch_claim", { step: "record", outcome: "nothing_to_claim", ...labels });
      throw new SocialRouteError("nothing_to_claim");
    }
    return { target, vaultId };
  }

  /** Logs a new attempt; the same id raced in, or taken with other facts, answers the stored row or a conflict. */
  async function logAttempt(context: SocialRequestContext, entry: TransactionEntry, progress: TransactionProgress, input: ClaimInput, fee: SocialTransferFee) {
    try {
      return { logged: await context.transaction((social) => logTransaction(social, entry, progress), { label: "social.launch_claim" }) };
    } catch (error) {
      if (!isUniqueViolation(error) && !(error instanceof TransactionLogConflict)) throw error;
      const stored = await read(entry.txId!);
      if (stored !== null && stored.account_id === entry.accountId && sameClaim(stored, input)) return { answer: context.json(claimBody(stored, input, { fee }), 200) };
      throw new SocialRouteError("claim_conflict");
    }
  }

  /** Step 1: check on chain, build, dry-run, sponsor, then log — `submitted` with what to sign, or `failed` before anything is signed. */
  async function record(context: SocialRequestContext, input: ClaimInput, requestId: string, participant: string, fee: SocialTransferFee): Promise<Response> {
    const labels = { kind: input.kind, fee };
    const reads = await chain();
    if (reads === null) {
      recordMetric("social.launch_claim", { step: "record", outcome: "claim_unavailable", ...labels });
      throw new SocialRouteError("claim_unavailable");
    }
    const { signal } = context.request;
    const { target, vaultId } = await claimable(reads, input, participant, labels, signal);
    const simulation = await reads.simulate(target.kindBytes, participant, { signal });
    const sponsored = simulation.status === "success"
      ? await sponsor({ caller: context.caller!, sender: participant, kindBytes: target.kindBytes, ip: context.client.rateKey, signal }).catch(sponsorRefusal)
      : null;

    // What the claim pays is the chain's to count at claim time: the row names the coins and leaves the amounts to it.
    const entry: TransactionEntry = {
      accountId: context.account!.account_id,
      kind: input.kind,
      idempotencyKey: launchClaimIdempotencyKey(input.kind, requestId, { launchId: input.launchId, vaultId }),
      txId: requestId,
      presaleId: null,
      coinType: target.memeType,
      quoteType: target.quoteType,
    };
    const progress: TransactionProgress =
      simulation.status === "success" ? { state: "submitted", digest: null } : { state: "failed", digest: null, failureCode: "dry_run_failed" };
    const attempt = await logAttempt(context, entry, progress, input, fee);
    if (attempt.answer) return attempt.answer;
    const { logged } = attempt;
    recordMetric("social.launch_claim", {
      step: "record",
      outcome: simulation.status === "success" ? "recorded" : "dry_run_failed",
      ...(simulation.status === "failure" ? { reason: simulation.failure.reason } : {}),
      ...labels,
    });
    return context.json(
      claimBody(logged.row, input, { fee, kindBytes: simulation.status === "success" ? target.kindBytes : null, sponsored }),
      logged.outcome === "recorded" ? 201 : 200,
    );
  }

  /** Step 2: the digest of the signed claim, then its settlement against the fullnode. */
  async function settle(context: SocialRequestContext, input: ClaimInput & { digest: string }, stored: TransactionRow, participant: string, fee: SocialTransferFee): Promise<Response> {
    const labels = { kind: input.kind, fee };
    if (stored.digest !== null && stored.digest !== input.digest) throw new SocialRouteError("claim_conflict");
    // An attempt that ended without a digest (declined, refused by a dry run, expired) takes none later.
    if (stored.digest === null && stored.state !== "submitted") throw new SocialRouteError("claim_conflict");
    if (stored.state !== "submitted") return context.json(claimBody(stored, input, { fee }), 200);

    // The digest is unique across every account: reserve it only once the caller's wallet is proven to have signed it.
    if (stored.digest === null) {
      await (dependencies.verifyProvenance ?? verifyDigestProvenance)(
        { digest: input.digest, sender: participant, transactionBytes: input.transactionBytes },
        async () => {
          const reads = await chain();
          const executed = reads === null ? null : await reads.executed(input.digest, { signal: context.request.signal });
          return executed?.sender ?? null;
        },
      );
    }
    const submitted = await advance(context, stored, { state: "submitted", digest: input.digest });
    if (submitted.state !== "submitted") return context.json(claimBody(submitted, input, { fee }), 200);

    const reads = await chain().catch(() => null);
    const executed = reads === null ? null : await reads.executed(input.digest, { signal: context.request.signal }).catch(() => null);
    if (executed === null) {
      recordMetric("social.launch_claim", { step: "settle", outcome: "not_visible", ...labels });
      return context.json(claimBody(submitted, input, { fee }), 202);
    }
    // The key binds what was recorded, the vault included (`sameClaim` checked it is this launch's).
    const binding = launchClaimBindingFromKey(submitted.kind, submitted.idempotency_key, submitted.tx_id)!;
    const verdict = launchClaimVerdict({ kind: input.kind, ...binding, participant }, executed);
    const settledAtMs = executed.timestampMs ?? undefined;
    const settled = await advance(
      context,
      submitted,
      verdict.state === "confirmed"
        ? { state: "confirmed", digest: input.digest, settledAtMs }
        : { state: "failed", digest: input.digest, failureCode: verdict.failureCode, settledAtMs },
    );
    recordMetric("social.launch_claim", {
      step: "settle",
      outcome: verdict.state === "confirmed" ? "confirmed" : verdict.failureCode,
      ...(verdict.state === "failed" && executed.failure ? { reason: executed.failure.reason } : {}),
      ...labels,
    });
    return context.json(claimBody(settled, input, { fee }), 200);
  }

  /** Step 3: nothing was sent — the wallet declined, or a simulation refused it. */
  async function fail(context: SocialRequestContext, input: ClaimInput & { failure: SocialClaimClientFailure }, stored: TransactionRow, fee: SocialTransferFee): Promise<Response> {
    // A transaction with a digest is the chain's to settle.
    if (stored.digest !== null) throw new SocialRouteError("claim_conflict");
    if (stored.state !== "submitted") {
      if (stored.failure_code === input.failure) return context.json(claimBody(stored, input, { fee }), 200);
      throw new SocialRouteError("claim_conflict");
    }
    const failed = await advance(context, stored, { state: "failed", digest: null, failureCode: input.failure });
    if (failed.state !== "failed" || failed.failure_code !== input.failure) throw new SocialRouteError("claim_conflict");
    recordMetric("social.launch_claim", { step: "fail", outcome: input.failure, kind: input.kind, fee });
    return context.json(claimBody(failed, input, { fee }), 200);
  }

  async function handle(context: SocialRequestContext): Promise<Response> {
    const requestId = requestIdOf(context.request);
    const input = parseClaim(await readDigestJson(context.request, ["launch_id", "kind"], ["digest", "failure"]));
    const caller = context.caller!;
    const accountId = context.account!.account_id;
    const fee = CLAIM_FEE;
    const participant = await blastWallet(caller);
    if (participant === null) throw new SocialRouteError("blast_wallet_missing");

    const stored = await read(requestId);
    // Another account's id is not this caller's to read.
    if (stored !== null && stored.account_id !== accountId) throw new SocialRouteError("not_found");
    if (stored !== null && !sameClaim(stored, input)) throw new SocialRouteError("claim_conflict");
    if (input.digest !== null) {
      if (stored === null) throw new SocialRouteError("not_found");
      return settle(context, { ...input, digest: input.digest }, stored, participant, fee);
    }
    if (input.failure !== null) {
      if (stored === null) throw new SocialRouteError("not_found");
      return fail(context, { ...input, failure: input.failure }, stored, fee);
    }
    if (stored !== null) return context.json(claimBody(stored, input, { fee }), 200);
    return record(context, input, requestId, participant, fee);
  }

  return Object.freeze({
    claim: kit.route({ name: LAUNCH_CLAIM_ROUTE, auth: "account", account: "required", bucket: "social_claim", cache: "private" }, handle),
  });
}

export type LaunchClaimRoutes = ReturnType<typeof createLaunchClaimRoutes>;
