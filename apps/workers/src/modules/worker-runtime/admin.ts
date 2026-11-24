import { aclAdminFieldName, decodeAclAdminRolesField, decodeAclObject } from "@interest-protocol/blast-admin-sdk";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import type { Provider } from "./provider.ts";
import { readSharedObject } from "./shared-object.ts";

class AdminReadError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export async function adminCapReference(
  client: ClientWithCoreApi,
  capId: string,
  owner: string,
  provider: Provider,
): Promise<Readonly<{ objectId: string; version: string; digest: string }> | null> {
  const { objects } = await provider((signal) => client.core.getObjects({ objectIds: [capId], signal }));
  const object = objects[0];
  if (!object || object instanceof Error) return null;
  if (object.owner.$kind !== "AddressOwner" || normalizeSuiAddress(object.owner.AddressOwner) !== normalizeSuiAddress(owner)) return null;
  return { objectId: normalizeSuiObjectId(object.objectId), version: String(object.version), digest: object.digest };
}

function roleType(role: string): string {
  return normalizeStructTag(role.startsWith("0x") ? role : `0x${role}`);
}

/**
 * The roles the ACL grants the cap now, as normalized type names; null when
 * the ACL holds no such cap (revoked or never granted).
 */
export async function capRoles(client: ClientWithCoreApi, deployment: BlastDeployment, capId: string, provider: Provider): Promise<string[] | null> {
  const acl = await readSharedObject(client, deployment.sharedObjects.admin.acl.objectId, provider);
  if (typeof acl === "string") throw new AdminReadError(acl);
  let adminsTableId: string;
  try {
    adminsTableId = decodeAclObject(acl, deployment.packages.admin.originalPackageId).adminsTableId;
  } catch {
    throw new AdminReadError("acl-unreadable");
  }
  let field;
  try {
    field = await provider((signal) => client.core.getDynamicField({ parentId: adminsTableId, name: aclAdminFieldName(capId), signal }));
  } catch (error) {
    if (error instanceof ObjectError && error.reason === "notFound") return null;
    throw error;
  }
  try {
    return decodeAclAdminRolesField(field.dynamicField, capId).map(roleType);
  } catch {
    throw new AdminReadError("acl-unreadable");
  }
}

/**
 * Whether `owner` holds the cap and the ACL grants it `role` alone. Throws when the cap or the ACL
 * cannot be read; each caller names its own blocking reasons.
 */
export async function adminCapStanding(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
  capId: string,
  owner: string,
  role: string,
  provider: Provider,
): Promise<"granted" | "not-owned" | "wrong-roles"> {
  if (!(await adminCapReference(client, capId, owner, provider))) return "not-owned";
  const roles = await capRoles(client, deployment, capId, provider);
  return roles?.length === 1 && roles[0] === role ? "granted" : "wrong-roles";
}
