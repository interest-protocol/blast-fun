import type { Pool } from "pg";
import { PartnerCapacityError } from "./capacity.ts";
import { z } from "zod";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { executePartnerKeyCommand, parsePartnerKeyCommand, type PartnerKeyPorts } from "@blast/server/modules/partner-api-keys/command.ts";
import { partnerIdSchema, partnerOriginsSchema, partnerKeyPolicySchema } from "@blast/server/modules/partner-api-keys/contracts.ts";
import { createPartner, issuePartnerApiKey, listPartnerApiKeys, revokePartnerApiKey, setPartnerOrigins, setPartnerKeyPolicy, deleteRevokedPartnerKey, deleteInactivePartnerGroup } from "@blast/server/modules/partner-api-keys/repository.ts";
import { partnerKeyUsage } from "@blast/server/modules/partner-api-keys/usage.ts";

const changeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create-partner"), id: partnerIdSchema, origins: partnerOriginsSchema }),
  z.strictObject({ action: z.literal("issue"), partnerId: partnerIdSchema, label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._:@-]{0,99}$/) }),
  z.strictObject({ action: z.literal("delete-partner"), id: partnerIdSchema }),
  z.strictObject({ action: z.literal("delete-key"), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }),
  z.strictObject({ action: z.literal("revoke"), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }),
  z.strictObject({ action: z.literal("set-policy"), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), policy: partnerKeyPolicySchema }),
]);
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const failed = (status: number, message: string) => Response.json({ error: message }, { status, headers: HEADERS });

async function readCommand(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new OperatorError("OPERATOR_INPUT_INVALID");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new OperatorError("OPERATOR_INPUT_INVALID");
      }
      chunks.push(value);
    }
    const change = changeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    if (change.action === "create-partner") return parsePartnerKeyCommand(["create-partner", change.id, ...change.origins]);
    if (change.action === "issue") return parsePartnerKeyCommand(["create", change.partnerId, change.label]);
    if (change.action === "set-policy") return parsePartnerKeyCommand([
      "set-policy", change.id, change.policy.tier,
      ...(change.policy.tier === "custom" ? [String(change.policy.requestsPerMinute), String(change.policy.requestsPerDay)] : []),
    ]);
    return parsePartnerKeyCommand([change.action, change.id]);
  } catch {
    throw new OperatorError("OPERATOR_INPUT_INVALID");
  } finally { reader.releaseLock(); }
}

function commandFailure(error: unknown): Response {
  if (error instanceof PartnerCapacityError) return failed(409, "Configured partner capacity cannot cover this change. Existing key entitlements are unchanged.");
  if (error instanceof OperatorError && error.code === "OPERATOR_INPUT_INVALID") return failed(400, "Enter a valid partner, key ID, policy and exact HTTPS origins (maximum 20). Limits must be positive integers; no wildcard origins or duplicates.");
  if (error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND") return failed(404, "Partner or key not found. Refresh the list.");
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "23514" && "constraint" in (error as object) &&
      (error as { constraint: unknown }).constraint === "partner_deletion_requires_revocation") {
    return failed(409, "Revoke all active keys before deleting a key or partner group. Refresh the list.");
  }
  if (code === "23505") return failed(409, "This partner already exists. Select it to issue a key.");
  if (code === "23503") return failed(404, "Partner not found. Refresh the list.");
  return failed(503, "Partner keys are unavailable. Refresh before trying again; if a key was issued without displaying its secret, revoke it and issue another.");
}

/** Never accepts a client-supplied audit actor. */
export function createAdminPartnerKeyRoute(ports: PartnerKeyPorts) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "POST") return failed(405, "Use GET or POST.");
    if (new URL(request.url).search) return failed(400, "Query parameters are not supported.");
    if (request.method === "POST" && request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return failed(415, "Expected JSON.");
    try {
      const command = request.method === "GET" ? parsePartnerKeyCommand(["list"]) : await readCommand(request);
      const result = await executePartnerKeyCommand(command, "operator:admin-console", ports);
      return Response.json(result, { headers: HEADERS });
    } catch (error) {
      return commandFailure(error);
    }
  };
}

export function partnerKeyAdminPorts(pool: () => Pool): PartnerKeyPorts {
  return {
    createPartner: (partner, by) => createPartner(pool(), partner, by),
    setOrigins: (partner, by) => setPartnerOrigins(pool(), partner, by),
    issue: (id, label, by) => issuePartnerApiKey(pool(), id, label, by),
    deleteKey: (id, by) => deleteRevokedPartnerKey(pool(), id, by),
    deletePartner: (id, by) => deleteInactivePartnerGroup(pool(), id, by),
    revoke: (id, by) => revokePartnerApiKey(pool(), id, by),
    setPolicy: (id, policy, by) => setPartnerKeyPolicy(pool(), id, policy, by),
    list: async () => {
      const result = await listPartnerApiKeys(pool());
      // Usage is optional telemetry; an outage must not prevent revocation.
      const usage = await partnerKeyUsage(pool(), result.keys).catch(() => null);
      return { ...result, usage };
    },
  };
}
