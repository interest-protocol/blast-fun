import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStructTag } from "@mysten/sui/utils";
import { parseCoinPageKey } from "./page-key.ts";

test("coin pages accept Move identifiers with leading underscores in nested types", () => {
  const type = "0x2::_pool::_Pool<vector<0x42::_coin::_Coin>>";
  assert.deepEqual(parseCoinPageKey(type), { kind: "coin-type", coinType: normalizeStructTag(type) });
  assert.equal(parseCoinPageKey("0x2::_pool::_Pool<0x42::9coin::_Coin>"), null);
});
