// Whether the Coin Registry shared a published currency. The object read from
// the node is the only authority.

import { COIN_REGISTRY_ID } from "@interest-protocol/blast-sdk";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { deriveObjectID, normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

export type SharedObjectFacts = Readonly<{ objectId: string; initialSharedVersion: string }>;

/** The shared `Currency<Meme>` the Coin Registry creates at its derived address, once registered. */
export async function findCurrencyRegistration(
  client: ClientWithCoreApi,
  memeType: string,
): Promise<SharedObjectFacts | null> {
  const meme = normalizeStructTag(memeType);
  const objectId = deriveObjectID(COIN_REGISTRY_ID, `0x2::coin_registry::CurrencyKey<${meme}>`, new Uint8Array([0]));
  const { objects } = await client.core.getObjects({ objectIds: [objectId] });
  const object = objects[0];
  if (!object || object instanceof Error || object.owner.$kind !== "Shared") return null;
  const tag = parseStructTag(object.type);
  const parameter = tag.typeParams[0];
  const matches =
    tag.address === normalizeSuiAddress("0x2") &&
    tag.module === "coin_registry" &&
    tag.name === "Currency" &&
    parameter !== undefined &&
    normalizeStructTag(parameter) === meme;
  return matches ? { objectId: object.objectId, initialSharedVersion: object.owner.Shared.initialSharedVersion } : null;
}
