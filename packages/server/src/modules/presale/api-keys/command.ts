import type { AuthorizedOperator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { z } from "zod";
import type { PresaleApiKeySummary, IssuedPresaleApiKey } from "./repository.ts";

/**
 * The agent API key operator command (`npm run presale:api-keys`): issue a
 * key under a label (the raw key is printed once and never stored), revoke
 * one by id, or list every key without its secret. Issuance and revocation
 * record the authenticated operator, as launchpad moderation does.
 */
export type ApiKeyCommand =
  | Readonly<{ mode: "create"; label: string }>
  | Readonly<{ mode: "revoke"; id: string }>
  | Readonly<{ mode: "list" }>;

/** The key store, bound to the primary. `issuedBy`/`revokedBy` are `operator:<operator ID>`. */
export type ApiKeyPorts = Readonly<{
  issue(label: string, issuedBy: string): Promise<IssuedPresaleApiKey>;
  revoke(id: string, revokedBy: string): Promise<PresaleApiKeySummary | null>;
  list(): Promise<PresaleApiKeySummary[]>;
}>;

/** The label rule of `presale_api_keys.label`. */
export const API_KEY_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:@-]{0,99}$/;
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `create <label>`, `revoke <id>` or `list`, exactly. */
export function parseApiKeyCommand(args: readonly string[]): ApiKeyCommand {
  const parsed = z
    .union([
      z.tuple([z.literal("list")]).transform(([mode]) => ({ mode })),
      z
        .tuple([z.literal("create"), z.string().regex(API_KEY_LABEL)])
        .transform(([mode, label]) => ({ mode, label })),
      z
        .tuple([z.literal("revoke"), z.string().regex(KEY_ID)])
        .transform(([mode, id]) => ({ mode, id })),
    ])
    .safeParse(args);
  if (!parsed.success) throw new OperatorError("OPERATOR_INPUT_INVALID");
  return parsed.data;
}

/**
 * Runs one command as `operator`, who is recorded as `operator:<operator ID>`
 * on the key it issues or revokes. Only `create` returns the raw key, once.
 */
export async function runApiKeyCommand(
  command: ApiKeyCommand,
  operator: AuthorizedOperator,
  ports: ApiKeyPorts,
): Promise<Record<string, unknown>> {
  const by = `operator:${operator.operatorId}`;
  if (command.mode === "create") return { apiKey: await ports.issue(command.label, by) };
  if (command.mode === "list") return { apiKeys: await ports.list() };
  const revoked = await ports.revoke(command.id, by);
  if (!revoked) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
  return { apiKey: revoked };
}
