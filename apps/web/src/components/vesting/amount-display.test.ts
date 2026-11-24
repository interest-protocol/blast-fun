import assert from "node:assert/strict";
import test from "node:test";
import { displayVestingAmount } from "./amount-display";
import {
  formatVestingAmount,
  parseVestingAmount,
} from "@blast/core/modules/vesting/model.ts";

test("display amounts floor to two decimals while transaction amounts stay exact", () => {
  const atoms = "10779617724446144";
  assert.equal(displayVestingAmount(atoms, 9), "10,779,617.72");
  assert.equal(displayVestingAmount("1000000000", 9), "1");
  assert.equal(displayVestingAmount("1250000000", 9), "1.25");
  assert.equal(displayVestingAmount("1999999999", 9), "1.99");
  assert.equal(formatVestingAmount(atoms, 9), "10779617.724446144");
  assert.equal(parseVestingAmount(formatVestingAmount(atoms, 9), 9), atoms);
});

test("tiny positive balances remain distinct from zero", () => {
  assert.equal(displayVestingAmount("0", 18), "0");
  assert.equal(displayVestingAmount("1", 18), "<0.01");
  assert.equal(displayVestingAmount("9999999", 9), "<0.01");
  assert.equal(displayVestingAmount("10000000", 9), "0.01");
});

test("u64 values and unknown decimals retain integer precision", () => {
  assert.equal(
    displayVestingAmount("18446744073709551615", 9),
    "18,446,744,073.7",
  );
  assert.equal(
    displayVestingAmount("18446744073709551615", 0),
    "18,446,744,073,709,551,615",
  );
  assert.equal(
    displayVestingAmount("18446744073709551615", null),
    "18,446,744,073,709,551,615 atoms",
  );
});
