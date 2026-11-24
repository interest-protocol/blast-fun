import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import type { VisibilityChange } from "./moderation.ts";
import { parseModerationCommand, runModerationCommand, type ModerationPorts } from "./moderation-command.ts";
import type { PostAudit, PostRecord } from "@blast/server/modules/launchpad-social/reads.ts";

const TOKEN = "moderation-operator-token-of-32-characters";
const operator = new OperatorAuthenticator({
  operatorId: "ops.jose",
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
}).authenticate("ops.jose", TOKEN);

const RECORD = "00000000-0000-4000-8000-000000000002";

function record(change: Partial<PostRecord> = {}): PostRecord {
  return {
    id: RECORD,
    thesisId: RECORD,
    revisionOf: null,
    launchId: `0x${"a1".padStart(64, "0")}`,
    kind: "community_thesis",
    stance: "bullish",
    authorIdentityId: "00000000-0000-4000-8000-0000000000c3",
    body: "Graduation looks near for Alpha.",
    evidenceLinks: [],
    disclosure: { text: null, walletAddress: null, verification: "not_requested", observedCheckpoint: null, observedAt: null },
    authorLabels: [],
    provenance: { network: "mainnet", deployment: "5".repeat(64), checkpoint: 9 },
    postedAt: "2026-10-01T12:10:00.000Z",
    createdAt: "2026-10-01T12:10:00.000Z",
    moderationState: "hidden",
    moderationChangedAt: "2026-10-01T13:00:00.000Z",
    ...change,
  };
}

function ports(answer: PostRecord | null = record()): ModerationPorts & { changes: VisibilityChange[]; audits: string[] } {
  const changes: VisibilityChange[] = [];
  const audits: string[] = [];
  return {
    changes,
    audits,
    setVisibility: async (change) => {
      changes.push(change);
      return answer;
    },
    audit: async (thesisId) => {
      audits.push(thesisId);
      return answer ? ({ records: [{ ...answer, author: { method: "privy", subjectKey: "f".repeat(64), walletAddress: null } }], moderation: [] } satisfies PostAudit) : null;
    },
  };
}

test("an operator command names one record or post and a short reason code, exactly", () => {
  assert.deepEqual(parseModerationCommand(["hide", RECORD, "spam"]), { mode: "hide", recordId: RECORD, reason: "spam" });
  assert.deepEqual(parseModerationCommand(["restore", RECORD, "appeal_upheld"]), { mode: "restore", recordId: RECORD, reason: "appeal_upheld" });
  assert.deepEqual(parseModerationCommand(["audit", RECORD]), { mode: "audit", thesisId: RECORD });
  for (const args of [
    [],
    ["delete", RECORD, "spam"],
    ["hide", RECORD],
    ["hide", "not-a-record", "spam"],
    ["hide", RECORD, "Not A Reason!"],
    ["hide", RECORD, "spam", "extra"],
    ["audit"],
    ["audit", RECORD, "spam"],
  ]) {
    assert.throws(() => parseModerationCommand(args), (error: unknown) => error instanceof OperatorError && error.code === "OPERATOR_INPUT_INVALID", JSON.stringify(args));
  }
});

test("hide and restore change one record's visibility as the authenticated operator, with the reason", async () => {
  const hiding = ports();
  const hidden = await runModerationCommand({ mode: "hide", recordId: RECORD, reason: "spam" }, operator, hiding);
  assert.deepEqual(hiding.changes, [{ recordId: RECORD, visibility: "hidden", reason: "spam", moderator: "operator:ops.jose" }]);
  assert.deepEqual(hidden, {
    record: { id: RECORD, thesisId: RECORD, launchId: record().launchId, moderationState: "hidden", moderationChangedAt: "2026-10-01T13:00:00.000Z" },
  });

  const restoring = ports(record({ moderationState: "public" }));
  await runModerationCommand({ mode: "restore", recordId: RECORD, reason: "appeal" }, operator, restoring);
  assert.equal(restoring.changes[0].visibility, "public");
});

test("an unknown record or post is the operator's not-found error; an audit returns every version and action", async () => {
  await assert.rejects(
    runModerationCommand({ mode: "hide", recordId: RECORD, reason: "spam" }, operator, ports(null)),
    (error: unknown) => error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND",
  );
  await assert.rejects(
    runModerationCommand({ mode: "audit", thesisId: RECORD }, operator, ports(null)),
    (error: unknown) => error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND",
  );
  const auditing = ports();
  const trail = await runModerationCommand({ mode: "audit", thesisId: RECORD }, operator, auditing);
  assert.deepEqual(auditing.audits, [RECORD]);
  assert.equal((trail as { audit: PostAudit }).audit.records[0].moderationState, "hidden");
});
