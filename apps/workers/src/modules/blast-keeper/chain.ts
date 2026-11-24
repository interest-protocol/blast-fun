// What the keeper jobs read from the chain, fresh through the canonical SDK
// before every attempt, shared by every keeper job: the shared launch (decoded
// against the deployment's launchpad lineage: foreign only on the SDK's
// explicit "not a launch of this lineage" outcomes, any other failure
// unreadable and retried), a coin's Coin Registry currency, Bluefin's current
// pool-creation fee, a launch's partner, and the presale and vault objects the
// keeper actions take.

import { COIN_REGISTRY_ID } from "@interest-protocol/blast-core/effects";
import {
  BluefinPoolCreationFeeError,
  getBluefinPoolCreationFee,
  vaultDeployment,
  type BlastDeployment,
} from "@interest-protocol/blast-deployments-sdk";
import { decodeLaunchObject, type LaunchState } from "@interest-protocol/blast-launchpad-sdk";
import { decodePartnerObject } from "@interest-protocol/blast-partners-sdk/state";
import { decodePresaleObject, type PresaleState } from "@interest-protocol/blast-presale-sdk/state";
import { decodeVaultObject, type VaultState } from "@interest-protocol/blast-vault-sdk/state";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import {
  deriveObjectID,
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiObjectId,
  parseStructTag,
} from "@mysten/sui/utils";

import type { Provider } from "../worker-runtime/provider.ts";
import { readSharedObject, type SharedObject } from "../worker-runtime/shared-object.ts";
import type { Candidate, KeeperContext } from "./actions.ts";

export type LaunchRead =
  /** The node has no such object (yet). */
  | Readonly<{ kind: "missing" }>
  /**
   * By the SDK launchpad reader's own explicit checks, not a shared
   * `launch::Launch` of this deployment's launchpad. The only read that
   * closes a record (`rejected`, `foreign-lineage`).
   */
  | Readonly<{ kind: "foreign"; reason: LaunchForeignReason }>
  /**
   * The node answered, but the object could not be read as a launch: a
   * decode (BCS) failure, an SDK or contract drift, a malformed type, no
   * content, or a node answering for another object. Never final: the record
   * is retried (`launch-unreadable`), uncounted.
   */
  | Readonly<{ kind: "unreadable"; reason: LaunchUnreadableReason }>
  | Readonly<{ kind: "launch"; launch: LaunchState }>;

/** Why an object is not a launch of the deployment: each one an explicit outcome of the SDK's reader. */
export type LaunchForeignReason = "not-shared" | "not-a-launch" | "mismatched-uid";

type LaunchUnreadableReason = "malformed-type" | "no-content" | "decode-failed" | "object-mismatch";

/**
 * The SDK launchpad reader's explicit "not a launch of this lineage"
 * refusals (`decodeLaunchObject` in its `launchpad/state.ts`), each a
 * TypeError with exactly this message. Any other error is not one of them.
 */
const SDK_FOREIGN: readonly (readonly [RegExp, LaunchForeignReason])[] = [
  [/^object 0x[0-9a-fA-F]+ is not a launch$/, "not-a-launch"],
  [/^launch 0x[0-9a-fA-F]+ must have two type arguments$/, "not-a-launch"],
  [/^launch 0x[0-9a-fA-F]+ has an unexpected package$/, "not-a-launch"],
  [/^launch 0x[0-9a-fA-F]+ has a mismatched UID$/, "mismatched-uid"],
];

/**
 * Classifies the node's answer for `launchId`. Foreign only when the owner
 * is not `Shared` (the SDK's `getLaunch`: "is not a shared object") or on the
 * SDK decoder's explicit refusals: "is not a launch", "must have two type
 * arguments", "has an unexpected package" (`not-a-launch`) and "has a
 * mismatched UID" (`mismatched-uid`). Anything else (a BCS failure, a
 * malformed type, no content, another object) is `unreadable`.
 */
export function classifyLaunchObject(
  object: Readonly<{ objectId: string; owner: SuiClientTypes.ObjectOwner; type: string; content: Uint8Array | undefined }>,
  launchId: string,
  launchpadOriginalPackageId: string,
): LaunchRead {
  if (object.owner.$kind !== "Shared") return { kind: "foreign", reason: "not-shared" };
  // Check the type before the SDK compares packages. A malformed type is
  // unreadable, so the record stays eligible for retry.
  try {
    if (!isValidSuiAddress(parseStructTag(object.type).address)) return { kind: "unreadable", reason: "malformed-type" };
  } catch {
    return { kind: "unreadable", reason: "malformed-type" };
  }
  if (!object.content) return { kind: "unreadable", reason: "no-content" };
  let launch: LaunchState;
  try {
    launch = decodeLaunchObject(
      {
        objectId: object.objectId,
        initialSharedVersion: object.owner.Shared.initialSharedVersion,
        mutable: true,
        type: object.type,
        content: object.content,
      },
      launchpadOriginalPackageId,
    );
  } catch (error) {
    const reason = error instanceof TypeError ? SDK_FOREIGN.find(([message]) => message.test(error.message))?.[1] : undefined;
    return reason ? { kind: "foreign", reason } : { kind: "unreadable", reason: "decode-failed" };
  }
  if (normalizeSuiObjectId(launch.objectId) !== normalizeSuiObjectId(launchId)) {
    return { kind: "unreadable", reason: "object-mismatch" };
  }
  return { kind: "launch", launch };
}

/**
 * The launch as the node holds it now, decoded only against the deployment's
 * launchpad lineage. A node failure propagates (`ProviderUnavailable`);
 * whatever the node answered is classified by `classifyLaunchObject`.
 */
export async function readLaunch(
  client: ClientWithCoreApi,
  launchId: string,
  launchpadOriginalPackageId: string,
  provider: Provider,
): Promise<LaunchRead> {
  const { objects } = await provider((signal) =>
    client.core.getObjects({ objectIds: [launchId], include: { content: true }, signal }),
  );
  const object = objects[0];
  if (!object || object instanceof Error) return { kind: "missing" };
  return classifyLaunchObject(object, launchId, launchpadOriginalPackageId);
}

/** Each launch as the node holds it now, in one read (see `readLaunch`), keyed by normalized ID. */
export async function readLaunches(
  client: ClientWithCoreApi,
  launchIds: readonly string[],
  launchpadOriginalPackageId: string,
  provider: Provider,
): Promise<ReadonlyMap<string, LaunchRead>> {
  const { objects } = await provider((signal) =>
    client.core.getObjects({ objectIds: [...launchIds], include: { content: true }, signal }),
  );
  return new Map(launchIds.map((launchId, index) => {
    const object = objects[index];
    const read: LaunchRead = !object || object instanceof Error
      ? { kind: "missing" }
      : classifyLaunchObject(object, launchId, launchpadOriginalPackageId);
    return [normalizeSuiObjectId(launchId), read];
  }));
}

export type RegistryCurrency = Readonly<{ objectId: string; initialSharedVersion: string }>;

/** The shared `Currency<coinType>` at its Coin Registry address, or null. */
export async function readRegistryCurrency(
  client: ClientWithCoreApi,
  coinType: string,
  provider: Provider,
): Promise<RegistryCurrency | null> {
  const objectId = sharedCurrencyId(coinType);
  const { objects } = await provider((signal) => client.core.getObjects({ objectIds: [objectId], signal }));
  const object = objects[0];
  if (!object || object instanceof Error || object.owner.$kind !== "Shared" || normalizeSuiObjectId(object.objectId) !== normalizeSuiObjectId(objectId)) return null;
  if (normalizeStructTag(object.type) !== normalizeStructTag(`0x2::coin_registry::Currency<${normalizeStructTag(coinType)}>`)) return null;
  return { objectId: normalizeSuiObjectId(object.objectId), initialSharedVersion: String(object.owner.Shared.initialSharedVersion) };
}

/**
 * Bluefin's configured SUI pool-creation fee in MIST, read now through the
 * SDK, or the SDK's typed reason it cannot be read. Only the reads run inside
 * the provider budget's abandonment; a typed failure is configuration, never
 * a provider outage.
 */
export async function readBluefinFee(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
  provider: Provider,
): Promise<bigint | BluefinPoolCreationFeeError> {
  return provider(async () => {
    try {
      return await getBluefinPoolCreationFee(client, deployment);
    } catch (error) {
      if (error instanceof BluefinPoolCreationFeeError) return error;
      throw error;
    }
  });
}

/** The address of `coinType`'s shared `Currency` in the Coin Registry (`0xc`), registered or not. */
export function sharedCurrencyId(coinType: string): string {
  return deriveObjectID(
    COIN_REGISTRY_ID,
    `0x2::coin_registry::CurrencyKey<${normalizeStructTag(coinType)}>`,
    new Uint8Array([0]),
  );
}

/** Validated shared Partner identities for permissionless fee payouts. */
export type SharedRef = Readonly<{ objectId: string; initialSharedVersion: string }>;

/** The partner the launch names, as a shared reference; null when it is not a partner of this deployment. */
export async function readPartner(
  client: ClientWithCoreApi,
  partnerId: string,
  partnersPackageId: string,
  provider: Provider,
): Promise<SharedRef | null> {
  const object = await readSharedObject(client, partnerId, provider);
  if (typeof object === "string") return null;
  try {
    const partner = decodePartnerObject(object, partnersPackageId);
    return { objectId: partner.objectId, initialSharedVersion: String(partner.initialSharedVersion) };
  } catch {
    return null;
  }
}


export async function sharedObject(context: KeeperContext, objectId: string): Promise<SharedObject> {
  const object = await readSharedObject(context.client, objectId, context.provider);
  if (typeof object === "string") throw new Error("shared-object-unavailable");
  return object;
}

export async function readSale(context: KeeperContext, row: Candidate): Promise<PresaleState> {
  const object = await sharedObject(context, row.object_id);
  const sale = decodePresaleObject(object, context.deployment.packages.presale.originalPackageId);
  if (normalizeStructTag(sale.saleTokenType) !== normalizeStructTag(row.meme_type) || normalizeStructTag(sale.quoteType) !== normalizeStructTag(row.quote_type)) throw new Error("presale-index-binding-mismatch");
  return sale;
}

export async function readVault(context: KeeperContext, row: Candidate): Promise<VaultState> {
  const object = await sharedObject(context, row.object_id);
  const vault = decodeVaultObject(object, vaultDeployment(context.deployment));
  const product = row.origin_kind === "launch" ? context.deployment.packages.launchpad : context.deployment.packages.presale;
  const witness = `${product.originalPackageId}::${row.origin_kind === "launch" ? "blast_fun" : "blast_presale_package"}::PackageWitness`;
  if ((row.origin_kind !== "launch" && row.origin_kind !== "presale") || !row.origin_id || !row.package_witness || !row.pool_id || !row.venue_type ||
      normalizeSuiObjectId(vault.terms.origin) !== normalizeSuiObjectId(row.origin_id) ||
      normalizeStructTag(vault.terms.packageWitness) !== normalizeStructTag(row.package_witness) ||
      normalizeStructTag(vault.terms.packageWitness) !== normalizeStructTag(witness) ||
      normalizeSuiObjectId(vault.poolId) !== normalizeSuiObjectId(row.pool_id) ||
      normalizeStructTag(vault.memeType) !== normalizeStructTag(row.meme_type) || normalizeStructTag(vault.quoteType) !== normalizeStructTag(row.quote_type)) throw new Error("vault-index-binding-mismatch");
  return vault;
}
