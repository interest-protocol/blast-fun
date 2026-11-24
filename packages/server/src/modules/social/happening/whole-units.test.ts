import assert from "node:assert/strict";
import test from "node:test";

import { wholeUnits } from "@blast/server/modules/social/happening/read.ts";

test("wholeUnits divides atoms exactly", () => {
  assert.equal(wholeUnits("1240000000000000", 9), "1240000");
  assert.equal(wholeUnits("250000000", 6), "250");
  assert.equal(wholeUnits("1", 6), "0.000001");
  assert.equal(wholeUnits("1500", 0), "1500");
  const notAtoms = { name: "TypeError", message: "Not atoms." };
  assert.throws(() => wholeUnits("-1", 2), notAtoms);
  assert.throws(() => wholeUnits("12a", 2), notAtoms);
  assert.throws(() => wholeUnits("1", -1), notAtoms);
});
