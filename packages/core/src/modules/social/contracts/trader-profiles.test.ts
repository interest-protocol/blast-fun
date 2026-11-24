import assert from "node:assert/strict";
import test from "node:test";
import { parseTraderProfilesRequest, traderProfilesPath } from "./trader-profiles.ts";
const trader = { address: `0x${"a".repeat(64)}`, timestampMs: 10 };
const parse = (rows: unknown) => parseTraderProfilesRequest(new URL(`https://blast.fun/api?traders=${encodeURIComponent(JSON.stringify(rows))}`), 20);
test("trader lookups bound input and preserve separate trade times", () => {
  assert.deepEqual(parse([trader, trader, { ...trader, timestampMs: 11 }]), [trader, { ...trader, timestampMs: 11 }]);
  for (const rows of [[], Array(5).fill(trader), [{ ...trader, address: "0x1" }], [{ ...trader, timestampMs: 21 }], [{ ...trader, timestampMs: 1.5 }], [{ ...trader, extra: true }]]) assert.equal(parse(rows), null);
  assert.deepEqual(parseTraderProfilesRequest(new URL(traderProfilesPath([trader]), "https://blast.fun"), 20), [trader]);
  for (const query of ["", "?traders=oops", "?traders=[]&traders=[]", "?traders=[]&extra=1"]) assert.equal(parseTraderProfilesRequest(new URL(`https://blast.fun/${query}`), 20), null);
});
