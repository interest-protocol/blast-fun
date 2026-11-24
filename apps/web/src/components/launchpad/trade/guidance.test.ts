import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { actionStateFixtures, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { CurveTradeInput } from "./curve-adapter.ts";
import { tradeGuidance } from "./guidance.ts";

const INPUT: CurveTradeInput = { launchId: `0x${"1b".repeat(32)}`, direction: "buy", amount: "10", slippageBps: 100n };
const states = actionStateFixtures(INPUT);
const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const LAUNCHPAD = deployment.packages.launchpad.packageId;
const guide = (state: Parameters<typeof tradeGuidance>[0]) => tradeGuidance(state, deployment);

function blocked(code: string, message = "Blocked.") {
  return { ...states.blocked, block: { ...(states.blocked as Extract<typeof states.blocked, { phase: "blocked" }>).block, code, message } } as typeof states.blocked;
}

test("each refusal or failure says whether to retry, refresh, adjust, change route, or stop, and keeps the input", () => {
  assert.equal(guide(blocked("insufficient-balance"))?.action, "adjust");
  assert.equal(guide(blocked("ineligible"))?.action, "adjust");
  assert.equal(guide(blocked("stale-lifecycle"))?.action, "stop");
  assert.equal(guide(blocked("stale-route"))?.action, "route");
  assert.equal(guide(blocked("fresh-read-unavailable"))?.action, "retry");
  assert.equal(guide(blocked("simulation-failed", `Sui rejected this transaction in simulation: MoveAbort in 2nd command, abort code: 13, in '${LAUNCHPAD}::launch::buy' (instruction 3)`))?.action, "refresh");
  assert.equal(guide(blocked("wrong-network"))?.action, "retry");
  const failed = (message: string) => ({ ...states.failed, message }) as typeof states.failed;
  assert.equal(guide(failed(`MoveAbort in 2nd command, abort code: 13, in '${LAUNCHPAD}::launch::buy' (instruction 3)`))?.action, "refresh");
  assert.match(guide(failed(`MoveAbort in 2nd command, abort code: 13, in '${LAUNCHPAD}::launch::buy' (instruction 3)`))?.text ?? "", /price moved/i);
  assert.equal(guide(failed(`MoveAbort in 2nd command, abort code: 12, in '${LAUNCHPAD}::launch::buy' (instruction 3)`))?.action, "stop");
  assert.equal(guide(failed(`MoveAbort in 2nd command, abort code: 13, in '0x${"ab".repeat(32)}::other::f' (instruction 3)`))?.action, "refresh");
  assert.doesNotMatch(guide(failed(`MoveAbort in 2nd command, abort code: 13, in '0x${"ab".repeat(32)}::other::f' (instruction 3)`))?.text ?? "", /price moved/i);
  assert.equal(guide(states.rejected)?.action, "retry");
  assert.equal(guide(states.ambiguous)?.action, "wait");
  assert.equal(guide(states.review), null);
  for (const text of Object.values(states).map((state) => guide(state)?.text ?? "")) {
    assert.doesNotMatch(text, /\b(long|short|leverage|leveraged|margin|position|liquidat)/i);
  }
});
