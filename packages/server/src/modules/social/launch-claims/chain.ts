import { defineBlastDeployment, launchpadDeployment, type BlastDeploymentInput } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchObject, LaunchpadTransactions } from "@interest-protocol/blast-sdk/launchpad";
import { decodeVaultObject } from "@interest-protocol/blast-sdk/vault";
import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { LaunchClaimKind } from "@blast/core/modules/social/contracts/launch-claims.ts";
import { launchClaimEvents, type LaunchClaimEvent, type LaunchClaimPackages } from "@blast/core/modules/social/claims/launch-events.ts";

/**
 * The launch claim's view of Sui (LP-12), on the released Blast deployment: the launch and its
 * live `CurveFeeCap` as the chain holds them, the claim's transaction kind built with the SDK
 * (`LaunchpadTransactions.claimCreatorFees`, `LaunchpadTransactions.claimOwnerBalances`), its dry
 * run and, once it executed, what it did. No call shape or event layout lives here. Nothing
 * here signs.
 */

/** Why a claim would not go, or did not go, through: a value-free label for metrics. */
export type LaunchClaimFailure = Readonly<{ moveAbort: string | null; reason: string }>;

export type LaunchClaimSimulation = Readonly<{ status: "success" }> | Readonly<{ status: "failure"; failure: LaunchClaimFailure }>;

/** What the claim pays and its kind to sign, once the chain showed it is the participant's to make. */
export type LaunchClaimTarget = Readonly<{ kindBytes: Uint8Array; memeType: string; quoteType: string }>;

export type ExecutedLaunchClaim = Readonly<{
  success: boolean;
  sender: string;
  failure: LaunchClaimFailure | null;
  claims: readonly LaunchClaimEvent[];
  timestampMs: number | null;
}>;

export type LaunchClaimChain = Readonly<{
  packages: LaunchClaimPackages;
  /**
   * The claim `kind` of `launchId` (with `vaultId` for the vault's) for `participant`, or null
   * when there is none to make: not a launch of this deployment, a cap the participant does not
   * hold, no vault of this launch, or nothing unclaimed in that ledger. A node failure rejects.
   */
  target(
    input: Readonly<{ launchId: string; kind: LaunchClaimKind; vaultId: string | null; participant: string }>,
    options?: { signal?: AbortSignal },
  ): Promise<LaunchClaimTarget | null>;
  /** Dry-runs the kind as `sender`, checks off: would it abort? */
  simulate(kind: Uint8Array, sender: string, options?: { signal?: AbortSignal }): Promise<LaunchClaimSimulation>;
  /** The executed transaction, or null while the node does not know the digest. */
  executed(digest: string, options?: { signal?: AbortSignal }): Promise<ExecutedLaunchClaim | null>;
}>;

/** An execution error, read: an abort in the launchpad or vault package by its module, else its kind. */
function launchClaimFailure(error: SuiClientTypes.ExecutionError | null | undefined, packages: LaunchClaimPackages): LaunchClaimFailure {
  if (error?.$kind === "MoveAbort") {
    const location = error.MoveAbort.location;
    const ours = location?.package !== undefined && [packages.launchpad, packages.vault].map((id) => normalizeSuiAddress(id)).includes(normalizeSuiAddress(location.package));
    return { moveAbort: null, reason: ours && location?.module ? `abort_${location.module}` : "external_abort" };
  }
  if (error && /insufficient[\s_]*gas/i.test(`${error.$kind} ${error.message}`)) return { moveAbort: null, reason: "insufficient_gas" };
  return { moveAbort: null, reason: error?.$kind ?? "unknown" };
}

type SharedObject = Readonly<{ objectId: string; initialSharedVersion: string; mutable: true; type: string; content: Uint8Array }>;

/** The shared object `objectId` with its content, or null when the node holds no such shared object. */
async function sharedObject(client: ClientWithCoreApi, objectId: string, signal?: AbortSignal): Promise<SharedObject | null> {
  const { objects } = await client.core.getObjects({ objectIds: [objectId], include: { content: true }, signal });
  const object = objects[0];
  if (!object || object instanceof Error || object.owner.$kind !== "Shared" || !object.content) return null;
  return {
    objectId: normalizeSuiAddress(object.objectId),
    initialSharedVersion: String(object.owner.Shared.initialSharedVersion),
    mutable: true,
    type: object.type,
    content: object.content,
  };
}

/** Whether the node shows `capId` owned by `participant`'s address. */
async function holds(client: ClientWithCoreApi, capId: string, participant: string, signal?: AbortSignal): Promise<boolean> {
  const { objects } = await client.core.getObjects({ objectIds: [capId], signal });
  const cap = objects[0];
  return !!cap && !(cap instanceof Error) && cap.owner.$kind === "AddressOwner" && normalizeSuiAddress(cap.owner.AddressOwner) === normalizeSuiAddress(participant);
}

/** A decoded object, or null when it is not one of the package's (the SDK's decoder refuses it). */
function decoded<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** The chain reads over a Core API client, for the released deployment `manifest`. */
export function createLaunchClaimChain(input: Readonly<{ client: ClientWithCoreApi; manifest: BlastDeploymentInput }>): LaunchClaimChain {
  const { client } = input;
  const deployment = defineBlastDeployment(input.manifest);
  const launchpad = launchpadDeployment(deployment);
  const packages: LaunchClaimPackages = { launchpad: launchpad.originalPackageId, vault: launchpad.vault.originalPackageId };
  const transactions = new LaunchpadTransactions(launchpad);
  const launchWitness = normalizeStructTag(`${launchpad.originalPackageId}::blast_fun::PackageWitness`);

  type Launch = ReturnType<typeof decodeLaunchObject> & Readonly<{ curveFeeCapId: string }>;
  type Types = Readonly<{ memeType: string; quoteType: string }>;

  /** The curve's claim, or null when its ledger holds nothing for the creator. */
  function curveClaim(launch: Launch, types: Types, recipient: string): Transaction | null {
    if (launch.creatorMemeFees === 0n && launch.creatorQuoteFees === 0n) return null;
    return transactions.claimCreatorFees({
      ...types,
      launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion },
      curveFeeCapId: launch.curveFeeCapId,
      recipient,
    });
  }

  /** The vault's claim, or null when the launch has not migrated, `vaultId` is not its vault, or it holds nothing for the creator. */
  async function vaultClaim(launch: Launch, types: Types, vaultId: string | null, recipient: string, signal?: AbortSignal): Promise<Transaction | null> {
    if (launch.lifecycle !== "Migrated" || vaultId === null) return null;
    const object = await sharedObject(client, vaultId, signal);
    const vault = object && decoded(() => decodeVaultObject(object, launchpad.vault));
    if (!vault || vault.terms.origin !== launch.objectId ||
      normalizeStructTag(vault.terms.packageWitness) !== launchWitness ||
      vault.memeType !== types.memeType || vault.quoteType !== types.quoteType) return null;
    if (vault.ownerMeme === 0n && vault.ownerQuote === 0n) return null;
    return transactions.claimOwnerBalances({
      ...types,
      vault: { objectId: vault.objectId, initialSharedVersion: vault.initialSharedVersion },
      launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion, mutable: false },
      curveFeeCapId: launch.curveFeeCapId,
      recipient,
    });
  }

  async function target(
    claim: Readonly<{ launchId: string; kind: LaunchClaimKind; vaultId: string | null; participant: string }>,
    options: { signal?: AbortSignal } = {},
  ): Promise<LaunchClaimTarget | null> {
    const object = await sharedObject(client, claim.launchId, options.signal);
    const launch = object && decoded(() => decodeLaunchObject(object, packages.launchpad));
    if (!launch || launch.curveFeeCapId === null) return null;
    const recipient = normalizeSuiAddress(claim.participant);
    if (!(await holds(client, launch.curveFeeCapId, recipient, options.signal))) return null;
    const live = { ...launch, curveFeeCapId: launch.curveFeeCapId };
    const types = { memeType: normalizeStructTag(launch.memeType), quoteType: normalizeStructTag(launch.quoteType) };
    const transaction = claim.kind === "claim_launch_fees"
      ? curveClaim(live, types, recipient)
      : await vaultClaim(live, types, claim.vaultId, recipient, options.signal);
    if (transaction === null) return null;
    return { kindBytes: await transaction.build({ client, onlyTransactionKind: true }), ...types };
  }

  return Object.freeze({
    packages,
    target,
    async simulate(kind, sender, options = {}) {
      const transaction = Transaction.fromKind(kind);
      transaction.setSender(normalizeSuiAddress(sender));
      const result = await client.core.simulateTransaction({ transaction, include: { effects: true }, checksEnabled: false, signal: options.signal });
      const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      const status = executed?.effects?.status ?? executed?.status;
      if (status?.success) return { status: "success" };
      return { status: "failure", failure: launchClaimFailure(status?.error, packages) };
    },
    async executed(digest, options = {}) {
      let result: SuiClientTypes.TransactionResult<{ effects: true; events: true; transaction: true }>;
      try {
        result = await client.core.getTransaction({ digest, include: { effects: true, events: true, transaction: true }, signal: options.signal });
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
        failure: status.success ? null : launchClaimFailure(status.error, packages),
        claims: launchClaimEvents(transaction.events ?? [], packages),
        timestampMs: transaction.timestampMs,
      };
    },
  });
}
