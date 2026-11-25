import assert from "node:assert/strict";
import test from "node:test";

import { CBLT, KSTL, SABL, TIDE, happeningPresale, happeningRead } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
import { presaleIdsOf } from "./presale-ids";

test("Home rows expire at the deadline across pins, fastest and upcoming cached lists", () => {
  const cancelled = happeningPresale({ presale_id: "cancelled", lifecycle: "cancelled" });
  const read = happeningRead({ today: [TIDE, CBLT, KSTL, cancelled, SABL], fastest: [TIDE], opening_soon: [SABL] });
  const before = presaleIdsOf(read, TIDE.presale.end_ms - 1);
  assert.deepEqual(before.ids, [TIDE.presale.presale_id, SABL.presale.presale_id]);
  assert.deepEqual([...before.featured], before.ids);
  const ended = presaleIdsOf(read, TIDE.presale.end_ms);
  assert.deepEqual(ended.ids, [SABL.presale.presale_id]);
  assert.deepEqual([...ended.featured], ended.ids);
  assert.deepEqual(presaleIdsOf(null, TIDE.presale.end_ms).ids, []);
});

test("an expired pin cannot re-enter Home from the cached fastest list", () => {
  const read = happeningRead({ today: [TIDE], fastest: [TIDE], opening_soon: [] });
  assert.deepEqual(presaleIdsOf(read, TIDE.presale.end_ms).ids, []);
});
