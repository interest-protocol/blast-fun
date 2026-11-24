import assert from "node:assert/strict";
import test from "node:test";

import { socialBridgeWithdrawSettlePath } from "@blast/core/modules/social/contracts/bridge-withdraw.ts";

test("a withdrawal's settle path names the withdrawal", () => {
  assert.equal(socialBridgeWithdrawSettlePath("00000000-0000-4000-8000-000000000001"), "/api/social/me/bridge-withdrawals/00000000-0000-4000-8000-000000000001/settle");
});
