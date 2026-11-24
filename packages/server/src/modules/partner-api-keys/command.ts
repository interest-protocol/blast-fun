import { z } from "zod";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { partnerIdSchema, partnerSchema, partnerKeyPolicySchema, partnerKeyIdSchema, partnerKeyLabelSchema, type Partner, type PartnerKeyPolicy } from "./contracts.ts";
import type { createPartner, setPartnerOrigins, issuePartnerApiKey, revokePartnerApiKey, listPartnerApiKeys, setPartnerKeyPolicy, deleteRevokedPartnerKey, deleteInactivePartnerGroup } from "./repository.ts";

type Command =
  | { mode: "create-partner"; partner: Partner }
  | { mode: "set-origins"; partner: Partner }
  | { mode: "create"; partnerId: string; label: string }
  | { mode: "revoke"; id: string }
  | { mode: "set-policy"; id: string; policy: PartnerKeyPolicy }
  | { mode: "delete-key" | "delete-partner"; id: string }
  | { mode: "list" };

const customQuotaArgumentsSchema = z.tuple([
  z.string().regex(/^[1-9][0-9]{0,9}$/),
  z.string().regex(/^[1-9][0-9]{0,9}$/),
]);

function parsePolicyCommand(args: readonly string[]): Command {
  const [, id, tier, minute, day] = args;
  if (tier === "custom" && !customQuotaArgumentsSchema.safeParse([minute, day]).success) {
    throw new OperatorError("OPERATOR_INPUT_INVALID");
  }
  const policy = partnerKeyPolicySchema.safeParse(tier === "custom"
    ? { tier, requestsPerMinute: Number(minute), requestsPerDay: Number(day) }
    : { tier });
  if (partnerKeyIdSchema.safeParse(id).success &&
      policy.success && args.length === (tier === "custom" ? 5 : 3)) {
    return { mode: "set-policy", id, policy: policy.data };
  }
  throw new OperatorError("OPERATOR_INPUT_INVALID");
}

export function parsePartnerKeyCommand(args: readonly string[]): Command {
  const [mode, id, label, ...rest] = args;
  if (mode === "list" && args.length === 1) return { mode };
  if (mode === "set-policy") return parsePolicyCommand(args);
  if (mode === "delete-partner" && args.length === 2 && partnerIdSchema.safeParse(id).success) return { mode, id };
  if ((mode === "revoke" || mode === "delete-key") && args.length === 2 && partnerKeyIdSchema.safeParse(id).success) return { mode, id };
  if (mode === "create" && args.length === 3 && partnerIdSchema.safeParse(id).success && partnerKeyLabelSchema.safeParse(label).success) {
    return { mode, partnerId: id, label };
  }
  if (mode === "create-partner" || mode === "set-origins") {
    const parsed = partnerSchema.safeParse({ id, origins: label === undefined ? [] : [label, ...rest] });
    if (parsed.success) return { mode, partner: parsed.data };
  }
  throw new OperatorError("OPERATOR_INPUT_INVALID");
}

export type PartnerKeyPorts = {
  createPartner(partner: Partner, by: string): ReturnType<typeof createPartner>;
  setOrigins(partner: Partner, by: string): ReturnType<typeof setPartnerOrigins>;
  issue(partnerId: string, label: string, by: string): ReturnType<typeof issuePartnerApiKey>;
  revoke(id: string, by: string): ReturnType<typeof revokePartnerApiKey>;
  setPolicy(id: string, policy: PartnerKeyPolicy, by: string): ReturnType<typeof setPartnerKeyPolicy>;
  deleteKey(id: string, by: string): ReturnType<typeof deleteRevokedPartnerKey>;
  deletePartner(id: string, by: string): ReturnType<typeof deleteInactivePartnerGroup>;
  list(): ReturnType<typeof listPartnerApiKeys>;
};

export async function runPartnerKeyCommand(command: Command, operator: Readonly<{ operatorId: string }>, ports: PartnerKeyPorts): Promise<unknown> {
  return executePartnerKeyCommand(command, `operator:${operator.operatorId}`, ports);
}

/** The caller authenticates before choosing the server-owned audit identity. */
export async function executePartnerKeyCommand(command: Command, by: string, ports: PartnerKeyPorts): Promise<unknown> {
  if (command.mode === "list") return ports.list();
  if (command.mode === "create") return { apiKey: await ports.issue(command.partnerId, command.label, by) };
  if (command.mode === "create-partner") return { partner: await ports.createPartner(command.partner, by) };
  if (command.mode === "set-origins") {
    const partner = await ports.setOrigins(command.partner, by);
    if (!partner) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
    return { partner };
  }
  if (command.mode === "set-policy") {
    const apiKey = await ports.setPolicy(command.id, command.policy, by);
    if (!apiKey) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
    return { apiKey };
  }
  if (command.mode === "delete-key") {
    assertDeleted(await ports.deleteKey(command.id, by));
    return { deletedKeyId: command.id };
  }
  if (command.mode === "delete-partner") {
    assertDeleted(await ports.deletePartner(command.id, by));
    return { deletedPartnerId: command.id };
  }
  const apiKey = await ports.revoke(command.id, by);
  if (!apiKey) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
  return { apiKey };
}

function assertDeleted(deleted: boolean): void {
  if (!deleted) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
}
