import assert from "node:assert/strict";
import test from "node:test";

import { hintOf } from "./hint-frames.ts";

const COIN = `0x${"3f".repeat(32)}::froggy::FROGGY`;

test("only a hint's selecting fields cross, and a malformed frame carries no hint", () => {
  assert.deepEqual(hintOf({ type: "activity", activity_id: "10:2:0:0", actor: "private", amount: "999" }), { type: "activity", activity_id: "10:2:0:0" });
  assert.equal(hintOf({ type: "activity", activity_id: "x".repeat(129) }), null);
  const sale = `0x${"a".repeat(64)}`;
  assert.deepEqual(
    hintOf({ type: "activity", activity_id: "10:2:0:0", kind: "trade_buy", presale_id: sale, coin_type: COIN, amount: "999" }),
    { type: "activity", activity_id: "10:2:0:0", kind: "trade_buy", presale_id: sale },
  );
  assert.deepEqual(
    hintOf({ type: "activity", activity_id: "10:3:0:0", kind: "trade_sell", presale_id: null, coin_type: COIN }),
    { type: "activity", activity_id: "10:3:0:0", kind: "trade_sell", coin_type: COIN },
  );
  assert.deepEqual(hintOf({ type: "presale_lifecycle", presale_id: sale, state: "funded", extra: 1 }), { type: "presale_lifecycle", presale_id: sale, state: "funded" });
  assert.equal(hintOf({ type: "presale_lifecycle", presale_id: sale, state: "drained" }), null);
  assert.deepEqual(
    hintOf({ type: "metadata", coin: COIN, cursor: "10:2:4294967295:0", metadata: { name: "private" }, decimals: "6" }),
    { type: "metadata", coin: COIN, cursor: "10:2:4294967295:0" },
  );
  assert.equal(hintOf({ type: "metadata", coin: "0x2::sui::SUI", cursor: "10:2:4294967295:0" }), null, "not canonical");
  assert.equal(hintOf({ type: "metadata", coin: COIN, cursor: "10:2" }), null);
  for (const type of ["trade", "pool_created", "lifecycle", "snapshot", "holders", "coin_market", undefined]) assert.equal(hintOf({ type, coin: COIN, checkpoint: 1, kinds: ["trade"] }), null, String(type));
});
