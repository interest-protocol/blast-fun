import assert from "node:assert/strict";
import test from "node:test";

import { atomsToUnits } from "./portfolio.ts";

test("UI-01: atoms convert exactly to the cent for any u64", () => {
  assert.equal(atomsToUnits("860000000", 6), 860);
  assert.equal(atomsToUnits("1", 6), 0);
  assert.equal(atomsToUnits("123456789", 6), 123.45);
  assert.equal(atomsToUnits("18446744073709551615", 6), 18446744073709.55);
  assert.equal(atomsToUnits("5", 0), 5);
});
