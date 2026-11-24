// What the chain says about one Meme type's registration, read fresh through
// the canonical SDK's Core API client before every attempt:
//
// - the shared `Currency<Meme>` at `deriveObjectID(0xc, CurrencyKey<Meme>)`,
//   present once anyone registered it;
// - otherwise the `Currency<Meme>` the Coin Registry address 0xc still owns,
//   the receiving reference `finalize_registration` needs, and the
//   publication that sent it (its last transaction);
// - that publication's effects, read by the SDK's `readMemePublication`
//   against the deployment's launchpad lineage.

import { COIN_REGISTRY_ID } from "@interest-protocol/blast-core/effects";
import { readMemePublication, type MemePublication } from "@interest-protocol/blast-launchpad-sdk";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { sharedCurrencyId } from "../blast-keeper/chain.ts";
import { readDigestOutcome } from "../worker-runtime/outcome.ts";
import { ProviderUnavailable, type Provider } from "../worker-runtime/provider.ts";

export type CurrencyReference = Readonly<{ objectId: string; version: string; digest: string }>;

export type PendingCurrency = Readonly<{ currency: CurrencyReference; publicationDigest: string | null }>;

/** The publication is not a configured-lineage Meme publication of this coin and currency. */
export class ForeignLineage extends Error {
  readonly code = "foreign-lineage";

  constructor() {
    super("The publication is not of the deployment's launchpad lineage.");
    this.name = "ForeignLineage";
  }
}

function isCurrencyOf(type: string, memeType: string): boolean {
  const tag = parseStructTag(type);
  const parameter = tag.typeParams[0];
  return (
    tag.address === normalizeSuiAddress("0x2") &&
    tag.module === "coin_registry" &&
    tag.name === "Currency" &&
    tag.typeParams.length === 1 &&
    parameter !== undefined &&
    normalizeStructTag(parameter) === normalizeStructTag(memeType)
  );
}

/** One bounded node call (the runtime's `provider`). Only the transport runs inside it; parsing never does. */

/** The shared currency's object ID once registered, or null. */
export async function readSharedCurrency(
  client: ClientWithCoreApi,
  memeType: string,
  provider: Provider,
): Promise<string | null> {
  return (await readSharedCurrencies(client, [memeType], provider)).get(memeType) ?? null;
}

/** Each registered Meme type's shared currency object ID, in one node call; unregistered types are absent. */
export async function readSharedCurrencies(
  client: ClientWithCoreApi,
  memeTypes: readonly string[],
  provider: Provider,
): Promise<ReadonlyMap<string, string>> {
  const objectIds = memeTypes.map(sharedCurrencyId);
  const { objects } = await provider((signal) => client.core.getObjects({ objectIds, signal }));
  const shared = new Map<string, string>();
  for (const [index, memeType] of memeTypes.entries()) {
    const object = objects[index];
    if (!object || object instanceof Error || object.owner.$kind !== "Shared") continue;
    if (isCurrencyOf(object.type, memeType)) shared.set(memeType, object.objectId);
  }
  return shared;
}

/** The `Currency<Meme>` 0xc owns, or null; more than one is never a registration to sign. */
export async function readPendingCurrency(
  client: ClientWithCoreApi,
  memeType: string,
  provider: Provider,
): Promise<PendingCurrency | null | "ambiguous"> {
  const response = await provider((signal) =>
    client.core.listOwnedObjects({
      owner: COIN_REGISTRY_ID,
      type: `0x2::coin_registry::Currency<${normalizeStructTag(memeType)}>`,
      include: { previousTransaction: true },
      limit: 2,
      signal,
    }),
  );
  const currencies = response.objects.filter((object) => isCurrencyOf(object.type, memeType));
  if (currencies.length > 1 || response.hasNextPage) return "ambiguous";
  const [currency] = currencies;
  if (!currency) return null;
  return {
    currency: { objectId: currency.objectId, version: currency.version, digest: currency.digest },
    publicationDigest: currency.previousTransaction ?? null,
  };
}

export type TransactionEffectsRead = Readonly<{
  effects: SuiClientTypes.TransactionEffects;
  objectTypes: Readonly<Record<string, string>>;
}> | null;

/** One transaction's effects and object types, or null when the node returns none for that digest. */
export async function readEffects(
  client: ClientWithCoreApi,
  digest: string,
  provider: Provider,
): Promise<TransactionEffectsRead> {
  const outcome = await readDigestOutcome(client, provider, digest, { effects: true, objectTypes: true });
  if (outcome.kind === "unknown") throw outcome.error;
  // Not found is a failed node call here, as a bounded provider reports it.
  if (outcome.kind === "not-found") throw new ProviderUnavailable("error");
  if (outcome.kind !== "executed" && outcome.kind !== "failed") return null;
  const { transaction } = outcome;
  return { effects: transaction.effects, objectTypes: transaction.objectTypes ?? {} };
}

/**
 * The SDK's reading of a publication's effects against the deployment's
 * launchpad: exactly one package, one `LaunchTicket` of this launchpad over
 * that package's Meme type, the Meme's `TreasuryCap` sealed beside it as the
 * core's `sealed_treasury_cap::SealedTreasuryCap<Meme>` (no raw
 * `coin::TreasuryCap` leaves a publication; contracts ADR 0138), and one
 * `Currency<Meme>` sent to 0xc, which must be this coin and this pending
 * currency. Anything else is `ForeignLineage`.
 */
export function checkLineage(
  publication: TransactionEffectsRead,
  memeType: string,
  currency: CurrencyReference,
  launchpad: Parameters<typeof readMemePublication>[1],
): MemePublication {
  if (!publication) throw new ForeignLineage();
  let read: MemePublication;
  try {
    read = readMemePublication(publication, launchpad);
  } catch {
    throw new ForeignLineage();
  }
  if (
    read.memeType !== normalizeStructTag(memeType) ||
    read.pendingCurrency.objectId !== normalizeSuiAddress(currency.objectId)
  ) {
    throw new ForeignLineage();
  }
  return read;
}

/** Whether `effects` succeeded and shared `currencyId`: this transaction registered it. */
export function sharedBy(effects: TransactionEffectsRead, currencyId: string): boolean {
  return Boolean(
    effects?.effects.status.success &&
      effects.effects.changedObjects.some(
        (object) =>
          object.idOperation === "Created" &&
          object.outputOwner?.$kind === "Shared" &&
          normalizeSuiAddress(object.objectId) === normalizeSuiAddress(currencyId),
      ),
  );
}
