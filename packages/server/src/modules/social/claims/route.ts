import { findClaim, findClaimPosition, findClaimVesting, shownSaleHasMigrated, type PositionRow, type VestingRow } from "./store.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_CLAIM_PATH } from "@blast/core/modules/backend-api/private/social-claims-contracts.ts";
import { readDigestJson, verifyDigestProvenance } from "@blast/server/modules/social/transactions/digest-provenance.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { isCreatorActionKind } from "@blast/core/modules/social/contracts/creator-earnings.ts";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import { claimIdempotencyKey, creatorVaultFromClaimKey, vestingScheduleFromClaimKey } from "@blast/core/modules/social/claims/identity.ts";
import {
  socialClaimInputSchema,
  SOCIAL_CLAIM_ROUTE,
  type SocialClaim,
  type SocialClaimClientFailure,
  type SocialClaimKind,
} from "@blast/core/modules/social/contracts/claims.ts";
import type { SocialTransferFee } from "@blast/core/modules/social/contracts/coins.ts";
import { atomsToUsd, PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { vestedAtoms, vestingSteps } from "@blast/core/modules/social/contracts/vesting.ts";
import type { SocialCaller, SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  logTransaction,
  TransactionLogConflict,
  type TransactionEntry,
  type TransactionProgress,
  type TransactionRow,
} from "@blast/core/modules/social/transactions/log.ts";
import { claimTransactionKind, claimVerdict, vestingClaimTransactionKind, type ClaimChain, type ClaimChainFailure } from "@blast/server/modules/social/claims/chain.ts";

/**
 * The claim route (R3-63; contract in `contracts/claims.ts`):
 * `PUT /api/social/me/claims/{request_id}`.
 *
 * The order is the whole point: **the attempt is in the account's
 * transaction log (R3-27) before the wallet is asked to sign**, then its
 * digest before the transaction is executed, then its outcome — so no claim
 * fails silently (§22.1 defect 2), and a client that disappears after
 * signing leaves a row the social worker can still settle from the indexer.
 *
 * Nothing on the network runs inside a database transaction: the record
 * step reads the position, then reads the chain and dry-runs, then writes
 * the log row in one short transaction; the settle step writes the digest,
 * then reads the fullnode, then writes the outcome.
 *
 * The log row's `tx_id` **is** the request id. Its key is `<kind>:<request
 * id>`, extended with the immutable schedule id for vesting claims. A replay
 * must match those recorded facts; a legacy vesting key cannot establish
 * which schedule was signed. Each attempt is its own id: a record call for
 * the same facts answers the row as it stands and builds nothing again.
 */

export type SocialClaimRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  verifyProvenance?: typeof verifyDigestProvenance;
  /** The primary (an owner sees what they just did). Resolved per request. */
  database: () => ReadableDatabase;
  /**
   * The mainnet presale deployment once its node answered with the right
   * chain, or null while claiming is off (no `PRESALE_DEPLOYMENT_MANIFEST`,
   * or one naming another network). Throws when the node cannot be reached.
   */
  deployment: (signal?: AbortSignal) => Promise<PresaleRuntimeIdentity | null>;
  /** The chain reads for that deployment (the presale node). */
  chain: (identity: PresaleRuntimeIdentity) => ClaimChain;
  /** The caller's Blast wallet: a Privy session's embedded Sui wallet (null until it exists), a wallet session's own address. */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
}>;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a schedule has vested more than it paid by `nowMs`, counting whole steps as the contract does. */
export function vestingClaimable(schedule: VestingRow | null, nowMs: number): boolean {
  if (schedule === null) return false;
  const times = { start_ms: Number(schedule.start_ms), cliff_end_ms: Number(schedule.cliff_end_ms), end_ms: Number(schedule.end_ms) };
  return vestedAtoms(BigInt(schedule.total), times, nowMs, vestingSteps(schedule)) > BigInt(schedule.claimed);
}

/**
 * What the wallet may claim from its position now: a cancelled sale's
 * refund, or a migrated sale's tokens (with any oversubscribed remainder,
 * paid by the same call); nothing before the sale settles, nothing without
 * a commitment, nothing once its claim is on chain. `previewClaim`'s rule
 * (claims open after migration or cancellation).
 */
export function openClaim(position: Pick<PositionRow, "lifecycle" | "commitment" | "claim_digest"> | null): SocialClaimKind | null {
  if (position === null || position.claim_digest !== null || !/^[1-9][0-9]*$/.test(position.commitment)) return null;
  if (position.lifecycle === "cancelled") return "claim_refund";
  if (position.lifecycle === "migrated") return "claim_tokens";
  return null;
}

/** Blast's gas pool pays every caller's network fee: a Privy embedded wallet and a wallet session alike (owner ruling 2026-11-20, reversing OA-17). */
const CLAIM_FEE: SocialTransferFee = "sponsored";

function requestIdOf(request: Request): string {
  const segment = routeSegments(SOCIAL_CLAIM_PATH, new URL(request.url).pathname)?.id ?? "";
  if (!z.string().regex(REQUEST_ID).safeParse(segment).success) throw new SocialRouteError("invalid_parameter");
  return segment;
}

type ClaimInput = Readonly<{
  presaleId: string;
  kind: SocialClaimKind;
  /** The vesting schedule, exactly for `claim_vesting`. */
  scheduleId: string | null;
  vaultId: string | null;
  digest: string | null;
  failure: SocialClaimClientFailure | null;
  transactionBytes?: unknown;
}>;

/** The closed claim body with exactly the identifiers that its action needs. */
function parseClaim(body: unknown): ClaimInput {
  const parsed = socialInput(socialClaimInputSchema, body);
  return {
    transactionBytes: parsed.transaction_bytes,
    presaleId: parsed.presale_id,
    kind: parsed.kind,
    scheduleId: parsed.schedule_id ?? null,
    vaultId: parsed.vault_id ?? null,
    digest: parsed.digest ?? null,
    failure: parsed.failure ?? null,
  };
}

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

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

function sameClaim(row: TransactionRow, input: ClaimInput): boolean {
  return row.kind === input.kind && row.presale_id === input.presaleId
    && row.idempotency_key === claimIdempotencyKey(input.kind, row.tx_id, input.scheduleId, input.vaultId);
}

function ownClaim(row: TransactionRow | null, accountId: string, input: ClaimInput): row is TransactionRow {
  return row !== null && row.account_id === accountId && sameClaim(row, input);
}

async function creatorKindForClaim(input: ClaimInput, participant: string, reads: ClaimChain, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!isCreatorActionKind(input.kind)) return null;
  const creator = input.vaultId ? await reads.creator?.(input.vaultId, participant, input.kind, signal) : null;
  if (!creator || creator.presaleId !== input.presaleId) throw new SocialRouteError("nothing_to_claim");
  return creator.kindBytes;
}

function claimEvidenceTarget(input: ClaimInput, stored: TransactionRow, participant: string) {
  return {
    presaleId: input.presaleId, participant,
    scheduleId: vestingScheduleFromClaimKey(stored.idempotency_key, stored.tx_id),
    vaultId: creatorVaultFromClaimKey(stored.kind, stored.idempotency_key, stored.tx_id),
    kind: isCreatorActionKind(input.kind) ? input.kind : undefined,
  };
}

function claimBody(
  row: TransactionRow,
  extra: Readonly<{ fee: SocialTransferFee; moveAbort?: string | null; kindBytes?: Uint8Array | null }>,
): SocialClaim {
  const open = row.state === "submitted" && row.digest === null;
  return {
    request_id: row.tx_id,
    presale_id: row.presale_id ?? "",
    kind: row.kind as SocialClaimKind,
    state: row.state,
    digest: row.digest,
    // The shared log also holds trade failures; claim writers only store claim failure codes.
    failure_code: row.failure_code as SocialClaim["failure_code"],
    move_abort: extra.moveAbort ?? null,
    fee: extra.fee,
    transaction_kind_bytes: open && extra.kindBytes ? toBase64(extra.kindBytes) : null,
    created_at_ms: Number(row.created_at_ms),
    settled_at_ms: row.settled_at_ms === null ? null : Number(row.settled_at_ms),
  };
}

export function createSocialClaimRoutes(dependencies: SocialClaimRouteDependencies) {
  const { kit, database, deployment, chain, blastWallet } = dependencies;

  const read = async (requestId: string): Promise<TransactionRow | null> =>
    findClaim(database(), requestId);

  /** Logs `progress` for the stored attempt; a row the worker settled first is answered as it now stands. */
  async function advance(context: SocialRequestContext, row: TransactionRow, progress: TransactionProgress): Promise<TransactionRow> {
    try {
      return await context.transaction(async (social) => (await logTransaction(social, entryOf(row), progress)).row, { label: "social.claim" });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SocialRouteError("claim_conflict");
      if (!(error instanceof TransactionLogConflict)) throw error;
      if (error.reason !== "outcome") throw new SocialRouteError("claim_conflict");
      return (await read(row.tx_id)) ?? row;
    }
  }

  function claimEntry(input: ClaimInput, accountId: string, requestId: string, presale: NonNullable<Awaited<ReturnType<ClaimChain["presale"]>>>, position: PositionRow | null, coinType: string): TransactionEntry {
    const refund = input.kind === "claim_refund";
    const quoteType = normalizeStructTag(presale.quote);
    return {
      accountId,
      kind: input.kind,
      idempotencyKey: claimIdempotencyKey(input.kind, requestId, input.scheduleId, input.vaultId),
      txId: requestId,
      presaleId: input.presaleId,
      coinType: refund ? null : normalizeStructTag(coinType),
      amount: null,
      quoteType: refund ? quoteType : null,
      quoteAmount: refund ? position!.commitment : null,
      usdValue: refund && quoteType === PORTFOLIO_COIN_TYPES.usdc ? atomsToUsd(position!.commitment, 6, "1") : null,
    };
  }

  /** A payable claim and its deployment; refuse an ineligible position before looking up the chain. */
  async function claimPreflight(
    input: ClaimInput,
    participant: string,
    fee: SocialTransferFee,
    signal: AbortSignal,
  ): Promise<Readonly<{ position: PositionRow | null; identity: PresaleRuntimeIdentity }>> {
    const vesting = input.scheduleId !== null;
    const creator = isCreatorActionKind(input.kind);
    const position = creator || vesting
      ? null
      : await findClaimPosition(database(), input.presaleId, participant);
    const open = creator
      ? await shownSaleHasMigrated(database(), input.presaleId)
      : vesting
      ? vestingClaimable(await findClaimVesting(database(), input.scheduleId, input.presaleId, participant), Date.now())
      : openClaim(position) === input.kind;
    if (!open) {
      recordMetric("social.claim", { step: "record", outcome: "nothing_to_claim", kind: input.kind, fee });
      throw new SocialRouteError("nothing_to_claim");
    }
    const identity = await deployment(signal);
    if (identity === null) {
      recordMetric("social.claim", { step: "record", outcome: "claim_unavailable", kind: input.kind, fee });
      throw new SocialRouteError("claim_unavailable");
    }
    return { position, identity };
  }

  /** The chain must hold a requested vesting schedule as one paying this wallet. */
  async function scheduleForClaim(input: ClaimInput, participant: string, fee: SocialTransferFee, reads: ClaimChain, signal: AbortSignal): Promise<Awaited<ReturnType<ClaimChain["vesting"]>>> {
    if (input.scheduleId === null) return null;
    const schedule = await reads.vesting(input.scheduleId, { signal });
    if (schedule === null || schedule.beneficiary !== normalizeSuiAddress(participant)) {
      // `chain_read_v1` names a schedule the chain does not hold as one paying this wallet.
      recordMetric("social.claim", { step: "record", outcome: "not_this_deployment", kind: input.kind, fee });
      throw new SocialRouteError("nothing_to_claim");
    }
    return schedule;
  }

  /** Step 1: check, build, dry-run, then log — `submitted` with the kind to sign, or `failed` before anything is signed. */
  async function record(
    context: SocialRequestContext,
    input: ClaimInput,
    requestId: string,
    participant: string,
    fee: SocialTransferFee,
  ): Promise<Response> {
    const accountId = context.account!.account_id;
    const labels = { kind: input.kind, fee };
    const { position, identity } = await claimPreflight(input, participant, fee, context.request.signal);
    const reads = chain(identity);
    const presale = await reads.presale(input.presaleId, { signal: context.request.signal });
    if (presale === null) {
      // `chain_read_v1` names a sale the manifest's package does not hold: not one Blast can claim from.
      recordMetric("social.claim", { step: "record", outcome: "not_this_deployment", ...labels });
      throw new SocialRouteError("nothing_to_claim");
    }
    const [schedule, creatorKind] = await settledAll([
      scheduleForClaim(input, participant, fee, reads, context.request.signal),
      creatorKindForClaim(input, participant, reads, context.request.signal),
    ]);
    const kindBytes = creatorKind ?? (schedule ? await vestingClaimTransactionKind(schedule) : await claimTransactionKind(identity, presale, participant));
    const simulation = await reads.simulate(kindBytes, participant, { signal: context.request.signal });
    const failure: ClaimChainFailure | null = simulation.status === "failure" ? simulation.failure : null;

    // What the claim moves, as far as it is known before it runs: a refund is
    // the whole commitment in the sale's quote coin (USDC is its own dollar
    // value); a launched sale's tokens and remainder are counted by the chain
    // at claim time, so the row names the coin and leaves the amount to it.
    const entry = claimEntry(input, accountId, requestId, presale, position, schedule?.coinType ?? presale.saleToken);
    const progress: TransactionProgress =
      failure === null ? { state: "submitted", digest: null } : { state: "failed", digest: null, failureCode: "dry_run_failed" };

    let logged: Readonly<{ row: TransactionRow; outcome: string }>;
    try {
      logged = await context.transaction((social) => logTransaction(social, entry, progress), { label: "social.claim" });
    } catch (error) {
      // The same id raced in from another request, or was taken with other facts.
      if (isUniqueViolation(error) || error instanceof TransactionLogConflict) {
        const stored = await read(requestId);
        if (ownClaim(stored, accountId, input)) {
          return context.json(claimBody(stored, { fee }), 200);
        }
        throw new SocialRouteError("claim_conflict");
      }
      throw error;
    }
    recordMetric("social.claim", {
      step: "record",
      outcome: failure === null ? "recorded" : "dry_run_failed",
      ...(failure === null ? {} : { reason: failure.reason }),
      ...labels,
    });
    return context.json(
      claimBody(logged.row, { fee, moveAbort: failure?.moveAbort ?? null, kindBytes: failure === null ? kindBytes : null }),
      logged.outcome === "recorded" ? 201 : 200,
    );
  }

  async function claimSender(digest: string, signal: AbortSignal): Promise<string | null> {
    const identity = await deployment(signal);
    return identity === null ? null : (await chain(identity).executed(digest, { signal }))?.sender ?? null;
  }

  async function visibleClaim(digest: string, signal: AbortSignal) {
    const identity = await deployment(signal).catch(() => null);
    if (identity === null) return null;
    try {
      return await chain(identity).executed(digest, { signal });
    } catch {
      return null;
    }
  }

  /** Step 2: the digest of the signed claim, then its settlement against the fullnode. */
  async function settle(
    context: SocialRequestContext,
    input: ClaimInput & { digest: string },
    stored: TransactionRow,
    participant: string,
    fee: SocialTransferFee,
  ): Promise<Response> {
    const labels = { kind: input.kind, fee };
    if (stored.digest !== null && stored.digest !== input.digest) throw new SocialRouteError("claim_conflict");
    // An attempt that ended without a digest (declined, refused by a dry run, expired) takes none later.
    if (stored.digest === null && stored.state !== "submitted") throw new SocialRouteError("claim_conflict");
    if (stored.state !== "submitted") return context.json(claimBody(stored, { fee }), 200);

    if (stored.digest === null) {
      await (dependencies.verifyProvenance ?? verifyDigestProvenance)(
        { digest: input.digest, sender: participant, transactionBytes: input.transactionBytes },
        () => claimSender(input.digest, context.request.signal),
      );
    }
    const submitted = await advance(context, stored, { state: "submitted", digest: input.digest });
    if (submitted.state !== "submitted") return context.json(claimBody(submitted, { fee }), 200);

    const executed = await visibleClaim(input.digest, context.request.signal);
    if (executed === null) {
      recordMetric("social.claim", { step: "settle", outcome: "not_visible", ...labels });
      return context.json(claimBody(submitted, { fee }), 202);
    }
    const verdict = claimVerdict(claimEvidenceTarget(input, submitted, participant), executed);
    const settledAtMs = executed.timestampMs ?? undefined;
    const settled = await advance(
      context,
      submitted,
      verdict.state === "confirmed"
        ? { state: "confirmed", digest: input.digest, settledAtMs }
        : { state: "failed", digest: input.digest, failureCode: verdict.failureCode, settledAtMs },
    );
    recordMetric("social.claim", {
      step: "settle",
      outcome: verdict.state === "confirmed" ? "confirmed" : verdict.failureCode,
      ...(verdict.state === "failed" && verdict.moveAbort ? { reason: verdict.moveAbort } : {}),
      ...labels,
    });
    return context.json(claimBody(settled, { fee, moveAbort: verdict.state === "failed" ? verdict.moveAbort : null }), 200);
  }

  /** Step 3: nothing was sent — the wallet declined, or a dry run refused it. */
  async function fail(
    context: SocialRequestContext,
    input: ClaimInput & { failure: SocialClaimClientFailure },
    stored: TransactionRow,
    fee: SocialTransferFee,
  ): Promise<Response> {
    // A transaction with a digest is the chain's to settle.
    if (stored.digest !== null) throw new SocialRouteError("claim_conflict");
    if (stored.state !== "submitted") {
      if (stored.failure_code === input.failure) return context.json(claimBody(stored, { fee }), 200);
      throw new SocialRouteError("claim_conflict");
    }
    const failed = await advance(context, stored, { state: "failed", digest: null, failureCode: input.failure });
    if (failed.state !== "failed" || failed.failure_code !== input.failure) throw new SocialRouteError("claim_conflict");
    recordMetric("social.claim", { step: "fail", outcome: input.failure, kind: input.kind, fee });
    return context.json(claimBody(failed, { fee }), 200);
  }

  async function handle(context: SocialRequestContext): Promise<Response> {
    const requestId = requestIdOf(context.request);
    const input = parseClaim(await readDigestJson(context.request, ["presale_id", "kind"], ["schedule_id", "vault_id", "digest", "failure", "transaction_bytes"]));
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
    if (stored !== null) return context.json(claimBody(stored, { fee }), 200);
    return record(context, input, requestId, participant, fee);
  }

  return Object.freeze({
    claim: kit.route({ name: SOCIAL_CLAIM_ROUTE, auth: "account", account: "required", bucket: "social_claim", cache: "private" }, handle),
  });
}

export type SocialClaimRoutes = ReturnType<typeof createSocialClaimRoutes>;
