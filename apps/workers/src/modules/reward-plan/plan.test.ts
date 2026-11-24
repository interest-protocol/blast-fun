import assert from "node:assert/strict";
import test from "node:test";
import { base, frozen } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";
import { planCommitment } from "./plan.ts";

// Plans already reserved in production store this hash; the executor refuses any plan whose
// recomputed hash differs. The value was computed with main's inline code before the move (d61da7d06).
test("a plan's commitment is the hash production already stored", () => {
  assert.equal(planCommitment(frozen, base.manifest, "a".repeat(64)), "ba55f2bf5147cc44521cd1cb8bbec3a3881c8811b032de2d5179464e990b0414");
});
