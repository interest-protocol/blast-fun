// One shared object as a transaction input: its content and the version it
// became shared at, or why it cannot be one. Each caller decides what a
// refusal means for it (throw, wait, or skip).

import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import type { Provider } from "./provider.ts";

export type SharedObject = SuiClientTypes.Object<{ content: true }> & Readonly<{ initialSharedVersion: string }>;

/**
 * `objectId` read with its content: the object, or `object-missing` (absent,
 * an error, or another id) or `object-not-shared` (not shared or no
 * content). Provider failures propagate.
 */
export async function readSharedObject(
  client: ClientWithCoreApi,
  objectId: string,
  provider: Provider,
): Promise<SharedObject | "object-missing" | "object-not-shared"> {
  const { objects } = await provider((signal) =>
    client.core.getObjects({ objectIds: [objectId], include: { content: true }, signal }),
  );
  const object = objects[0];
  if (!object || object instanceof Error || normalizeSuiObjectId(object.objectId) !== normalizeSuiObjectId(objectId)) {
    return "object-missing";
  }
  if (object.owner.$kind !== "Shared" || !object.content) return "object-not-shared";
  return { ...object, initialSharedVersion: String(object.owner.Shared.initialSharedVersion) };
}
