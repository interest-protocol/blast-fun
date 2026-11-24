import { z } from "zod";
import type { AuthorizedOperator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { parseRecordId } from "@blast/server/modules/launchpad-social/contracts.ts";
import { MODERATION_REASON, type VisibilityChange } from "./moderation.ts";
import type { PostAudit, PostRecord } from "@blast/server/modules/launchpad-social/reads.ts";

/**
 * The launchpad's moderation operator command (`npm run launchpad:moderate`):
 * an authenticated operator hides or restores one post record, or reads a
 * post's audit. Nothing is deleted: a hidden record leaves the public list
 * and search at once (the reads take social records from the primary), and
 * its author, text, provenance and every moderation action stay. No
 * threshold or automatic moderation exists: each change is one operator's
 * decision with a short reason code.
 */

export type ModerationCommand =
  | Readonly<{ mode: "hide" | "restore"; recordId: string; reason: string }>
  | Readonly<{ mode: "audit"; thesisId: string }>;

/** The social module's moderation and audit, bound to the primary. */
export type ModerationPorts = Readonly<{
  setVisibility(change: VisibilityChange): Promise<PostRecord | null>;
  audit(thesisId: string): Promise<PostAudit | null>;
}>;

function invalid(): OperatorError {
  return new OperatorError("OPERATOR_INPUT_INVALID");
}

function recordId(value: string): string {
  try {
    return parseRecordId(value);
  } catch {
    throw invalid();
  }
}

/** `hide <recordId> <reason>`, `restore <recordId> <reason>` or `audit <thesisId>`, exactly. */
export function parseModerationCommand(args: readonly string[]): ModerationCommand {
  const [mode, id, reason, ...rest] = args;
  if (rest.length > 0 || id === undefined) throw invalid();
  if (mode === "audit" && reason === undefined) return { mode, thesisId: recordId(id) };
  if ((mode === "hide" || mode === "restore") && reason !== undefined && z.string().regex(MODERATION_REASON).safeParse(reason).success) {
    return { mode, recordId: recordId(id), reason };
  }
  throw invalid();
}

/** Runs one command as `operator`; the moderator recorded is `operator:<operator ID>`. */
export async function runModerationCommand(
  command: ModerationCommand,
  operator: AuthorizedOperator,
  ports: ModerationPorts,
): Promise<Record<string, unknown>> {
  if (command.mode === "audit") {
    const audit = await ports.audit(command.thesisId);
    if (!audit) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
    return { audit };
  }
  const changed = await ports.setVisibility({
    recordId: command.recordId,
    visibility: command.mode === "hide" ? "hidden" : "public",
    reason: command.reason,
    moderator: `operator:${operator.operatorId}`,
  });
  if (!changed) throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
  return {
    record: {
      id: changed.id,
      thesisId: changed.thesisId,
      launchId: changed.launchId,
      moderationState: changed.moderationState,
      moderationChangedAt: changed.moderationChangedAt,
    },
  };
}
