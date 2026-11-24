import {
  PresaleTransactions,
  presaleAbortName,
  presaleEventBcs,
  presaleEventModules,
} from "@interest-protocol/blast-sdk/presale";
import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { createCreatorChain, type CreatorChain } from "@blast/server/modules/social/creator-earnings/chain.ts";
import { creatorEvents, type CreatorEvent } from "@blast/core/modules/social/claims/creator-events.ts";
import type { CreatorActionKind } from "@blast/core/modules/social/contracts/creator-earnings.ts";

import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import {
  decodeLinearVesting,
  LINEAR_VESTING_ABORTS,
  LINEAR_VESTING_MODULE,
  linearVestingClaim,
  vestingClaimedEvents,
  type LinearVestingSchedule,
} from "@blast/core/modules/sponsor/linear-vesting.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";

/**
 * The claim transaction's view of Sui (R3-63): the sale's shared object, the
 * claim's transaction kind, its dry run and, once it executed, what it did.
 * Built on the published SDK's `PresaleTransactions.claim`, the presale
 * package's one abort map (`presaleAbortName`) and its `Claimed` event
 * layout — so no call shape or abort code lives here. Mainnet only: the route
 * reaches this with a mainnet identity or not at all. Nothing here signs.
 */

/** The sale's shared object as `claim` takes it, and its type arguments, as the chain holds them. */
export type ClaimPresale = Readonly<{ objectId: string; initialSharedVersion: string; saleToken: string; quote: string }>;

/**
 * Why a claim would not go, or did not go, through on chain. `moveAbort` is
 * the SDK's name for an abort of the presale package (`ENoCommitment`,
 * `EInvalidLifecycle`, …) and null for anything else; `reason` is a
 * value-free label for metrics (the abort's name, `external_abort`,
 * `insufficient_gas`, or the error's kind).
 */
export type ClaimChainFailure = Readonly<{ moveAbort: string | null; reason: string }>;

export type ClaimSimulation = Readonly<{ status: "success" }> | Readonly<{ status: "failure"; failure: ClaimChainFailure }>;

/** One presale `events::Claimed` receipt with the participant and amounts. */
export type ClaimedEvent = Readonly<{ presaleId: string; participant: string; tokens: string; quoteRefund: string }>;

/** One `blast_fun_linear_vesting::VestingClaimed` event: which schedule paid whom (P-13). */
export type VestingClaimedEvent = Readonly<{ vestingId: string; beneficiary: string }>;

/** An executed transaction, as the settlement reads it. */
export type ExecutedClaim = Readonly<{
  success: boolean;
  sender: string;
  /** Why it aborted; null when it succeeded. */
  failure: ClaimChainFailure | null;
  claims: readonly ClaimedEvent[];
  vestingClaims: readonly VestingClaimedEvent[];
  creatorEvents?: readonly CreatorEvent[];
  /** The checkpoint's time, when the node has it. */
  timestampMs: number | null;
}>;

/**
 * What the claim route reads from the chain. A node failure rejects (the
 * route answers `service_unavailable` while recording; a settlement just
 * waits for the next call).
 */
export type ClaimChain = Readonly<{
  creator?: CreatorChain["transaction"];
  /** The sale's object, or null when `presaleId` is not a presale of this deployment. */
  presale(presaleId: string, options?: { signal?: AbortSignal }): Promise<ClaimPresale | null>;
  /** The vesting schedule's object, or null when `scheduleId` is not a `blast_fun_linear_vesting` schedule (P-13). */
  vesting(scheduleId: string, options?: { signal?: AbortSignal }): Promise<LinearVestingSchedule | null>;
  /** Dry-runs the claim's kind as `sender` (no gas, checks off): would it abort? */
  simulate(kind: Uint8Array, sender: string, options?: { signal?: AbortSignal }): Promise<ClaimSimulation>;
  /** The executed transaction, or null while the node does not know the digest. */
  executed(digest: string, options?: { signal?: AbortSignal }): Promise<ExecutedClaim | null>;
}>;

/** The presale package's ids an abort location may name (the original and the current). */
function presalePackages(identity: PresaleRuntimeIdentity): ReadonlySet<string> {
  return new Set([identity.presale.packageId, identity.presale.originalPackageId].map((id) => normalizeSuiAddress(id)));
}

/** The abort's error code: the clever error's `errorCode`, else a plain abort code. */
function abortCode(abort: SuiClientTypes.MoveAbort): number | null {
  const clever = abort.cleverError?.errorCode;
  if (typeof clever === "number" && Number.isSafeInteger(clever)) return clever;
  const plain = /^[0-9]{1,15}$/.test(abort.abortCode) ? Number(abort.abortCode) : null;
  return plain !== null && Number.isSafeInteger(plain) ? plain : null;
}

/**
 * An execution error, read: a presale-package Move abort by the SDK's name
 * (CL-19's rule: only an abort located in the presale package is named, since
 * other packages reuse module names), or the pinned vesting package's
 * `ENothingClaimable` (P-13), else `external_abort` for any other abort,
 * `insufficient_gas`, or the error's own kind.
 */
export function claimChainFailure(
  error: SuiClientTypes.ExecutionError | null | undefined,
  identity: PresaleRuntimeIdentity,
): ClaimChainFailure {
  if (error?.$kind === "MoveAbort") {
    const abort = error.MoveAbort;
    const location = abort.location;
    const ours = location?.package !== undefined && presalePackages(identity).has(normalizeSuiAddress(location.package));
    const code = abortCode(abort);
    const vesting = location?.package !== undefined && normalizeSuiAddress(location.package) === VESTING_PACKAGE && location.module === LINEAR_VESTING_MODULE;
    const name = ours && location?.module && code !== null
      ? presaleAbortName(code)
      : vesting && code !== null ? (LINEAR_VESTING_ABORTS[code] ?? null) : null;
    return { moveAbort: name, reason: name ?? "external_abort" };
  }
  if (error && /insufficient[\s_]*gas/i.test(`${error.$kind} ${error.message}`)) return { moveAbort: null, reason: "insufficient_gas" };
  return { moveAbort: null, reason: error?.$kind ?? "unknown" };
}

/**
 * The claim for one participant: `blast_presale::claim<SaleToken, Quote>(presale,
 * participant)` through the SDK, as a transaction kind (base64-ready bytes).
 * No sender and no gas: a sponsored claim gets both from the sponsor, a
 * wallet-paid one from its own wallet. Every input is resolved (the shared
 * object carries its version), so building needs no node.
 */
export async function claimTransactionKind(
  identity: PresaleRuntimeIdentity,
  presale: ClaimPresale,
  participant: string,
): Promise<Uint8Array> {
  const transaction = new PresaleTransactions(identity.presale).claim({
    saleTokenType: normalizeStructTag(presale.saleToken),
    quoteType: normalizeStructTag(presale.quote),
    presale: { objectId: presale.objectId, initialSharedVersion: presale.initialSharedVersion },
    participants: [normalizeSuiAddress(participant)],
  });
  return transaction.build({ onlyTransactionKind: true });
}

/** A vesting schedule's claim (P-13): `blast_fun_linear_vesting::claim<T>(schedule, clock)`, as a transaction kind. */
export async function vestingClaimTransactionKind(schedule: LinearVestingSchedule): Promise<Uint8Array> {
  return linearVestingClaim(schedule).build({ onlyTransactionKind: true });
}

/** The `Claimed` events among `events` emitted by this deployment's presale package. */
export function claimedEvents(events: readonly Pick<SuiClientTypes.Event, "eventType" | "bcs">[], identity: PresaleRuntimeIdentity): ClaimedEvent[] {
  const original = normalizeSuiAddress(identity.presale.originalPackageId);
  return events.flatMap((event) => {
    try {
      const tag = parseStructTag(event.eventType);
      if (normalizeSuiAddress(tag.address) !== original || tag.module !== presaleEventModules.Claimed || tag.name !== "Claimed") return [];
      const payload = presaleEventBcs.Claimed.parse(event.bcs);
      return [{
        presaleId: normalizeSuiAddress(String(payload.presale_id)),
        participant: normalizeSuiAddress(String(payload.participant)),
        tokens: String(payload.tokens),
        quoteRefund: String(payload.quote_refund),
      }];
    } catch {
      return [];
    }
  });
}

/** Where a recorded claim stands once its digest executed. */
export type ClaimVerdict =
  | Readonly<{ state: "confirmed" }>
  | Readonly<{ state: "failed"; failureCode: "execution_failed" | "mismatch"; moveAbort: string | null }>;

/**
 * The verdict on a recorded claim from its executed transaction: `confirmed`
 * when the Blast wallet sent it, it succeeded, and it paid that wallet from
 * that sale (a vesting claim: from that schedule); `execution_failed` when
 * the wallet's transaction aborted (naming the abort); `mismatch` for any
 * other transaction (another sender, or a success that paid someone else or
 * another sale).
 */
export function claimVerdict(
  claim: Readonly<{ presaleId: string; participant: string; scheduleId?: string | null; vaultId?: string | null; kind?: CreatorActionKind }>,
  executed: ExecutedClaim,
): ClaimVerdict {
  const participant = normalizeSuiAddress(claim.participant);
  if (normalizeSuiAddress(executed.sender) !== participant) return { state: "failed", failureCode: "mismatch", moveAbort: null };
  if (!executed.success) return { state: "failed", failureCode: "execution_failed", moveAbort: executed.failure?.moveAbort ?? null };
  const presaleId = normalizeSuiAddress(claim.presaleId);
  const scheduleId = claim.scheduleId ? normalizeSuiAddress(claim.scheduleId) : null;
  const paid = claim.vaultId ? executed.creatorEvents?.some((event) => event.vaultId === claim.vaultId && event.kind === claim.kind) === true : scheduleId === null
    ? executed.claims.some((event) => event.presaleId === presaleId && event.participant === participant)
    : executed.vestingClaims.some((event) => event.vestingId === scheduleId && event.beneficiary === participant);
  return paid
    ? { state: "confirmed" }
    : { state: "failed", failureCode: "mismatch", moveAbort: null };
}

/**
 * The chain reads over a Core API client (the presale node): the sale's type
 * arguments and shared version from its object (refusing an object that is
 * not this deployment's `Presale`), the dry run with checks off (an embedded
 * wallet holds no SUI for gas; the dry run is only asked whether the call
 * aborts), and the executed transaction with its events.
 */
export function createClaimChain(input: Readonly<{ client: ClientWithCoreApi; identity: PresaleRuntimeIdentity }>): ClaimChain {
  const { core } = input.client;
  const { identity } = input;
  const original = normalizeSuiAddress(identity.presale.originalPackageId);
  return Object.freeze({
    creator: createCreatorChain(input.client, identity).transaction,
    async presale(presaleId, options = {}) {
      const { objects } = await core.getObjects({ objectIds: [presaleId], signal: options.signal });
      const object = objects[0];
      if (!object || object instanceof Error || object.owner.$kind !== "Shared") return null;
      const tag = parseStructTag(object.type);
      const [saleToken, quote, ...extra] = tag.typeParams;
      if (normalizeSuiAddress(tag.address) !== original || tag.module !== "blast_presale" || tag.name !== "Presale") return null;
      if (saleToken === undefined || quote === undefined || extra.length > 0) return null;
      return {
        objectId: normalizeSuiAddress(object.objectId),
        initialSharedVersion: String(object.owner.Shared.initialSharedVersion),
        saleToken: normalizeStructTag(saleToken),
        quote: normalizeStructTag(quote),
      };
    },
    async vesting(scheduleId, options = {}) {
      const { objects } = await core.getObjects({ objectIds: [scheduleId], include: { content: true }, signal: options.signal });
      const object = objects[0];
      return !object || object instanceof Error ? null : decodeLinearVesting(object);
    },
    async simulate(kind, sender, options = {}) {
      const transaction = Transaction.fromKind(kind);
      transaction.setSender(normalizeSuiAddress(sender));
      const result = await core.simulateTransaction({
        transaction,
        include: { effects: true },
        checksEnabled: false,
        signal: options.signal,
      });
      const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      const status = executed?.effects?.status ?? executed?.status;
      if (status?.success) return { status: "success" };
      return { status: "failure", failure: claimChainFailure(status?.error, identity) };
    },
    async executed(digest, options = {}) {
      let result: SuiClientTypes.TransactionResult<{ effects: true; events: true; transaction: true }>;
      try {
        result = await core.getTransaction({ digest, include: { effects: true, events: true, transaction: true }, signal: options.signal });
      } catch (error) {
        if (error instanceof TransactionError && error.reason === "notFound") return null;
        throw error;
      }
      const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      const sender = transaction?.transaction?.sender;
      if (!transaction || typeof sender !== "string" || transaction.digest !== digest) return null;
      const status = transaction.effects?.status ?? transaction.status;
      return {
        success: status.success,
        sender: normalizeSuiAddress(sender),
        failure: status.success ? null : claimChainFailure(status.error, identity),
        claims: claimedEvents(transaction.events ?? [], identity),
        vestingClaims: vestingClaimedEvents(transaction.events ?? []),
        creatorEvents: creatorEvents(transaction.events ?? [], identity.presale.vault.originalPackageId),
        timestampMs: transaction.timestampMs,
      };
    },
  });
}
