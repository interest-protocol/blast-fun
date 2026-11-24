import assert from "node:assert/strict";
import test from "node:test";

import { compareDecimal, toUsd } from "./decimal.ts";

test("USD rounding preserves signed ties, carries and digits beyond Decimal's arithmetic precision", () => {
  for (const [value, expected] of [
    ["0", "0.00"], ["00017.5", "17.50"], ["1.005", "1.01"], ["-1.005", "-1.01"],
    ["0.0049", "0.00"], ["-0.0049", "0.00"], ["-0.005", "-0.01"], ["-0", "0.00"],
    ["99.995", "100.00"], ["-99.995", "-100.00"],
    ["123456789012345678901234567890.125", "123456789012345678901234567890.13"],
  ]) assert.equal(toUsd(value), expected, value);
});

test("decimal thresholds compare all digits, including negative amounts and unequal scales", () => {
  assert.equal(compareDecimal("1000", "1000.000"), 0);
  assert.equal(compareDecimal("-0", "0.00"), 0);
  assert.equal(compareDecimal("-0.001", "0"), -1);
  assert.equal(compareDecimal("-2", "-2.001"), 1);
  assert.equal(compareDecimal("123456789012345678901234567890.5", "123456789012345678901234567890.49"), 1);
  assert.equal(compareDecimal("0.000000000000000000000000000001", "0"), 1);
});

test("SQL decimal grammar rejects exponents, non-finite values and alternate number syntax", () => {
  for (const value of ["", "1e3", "NaN", "Infinity", ".5", "1.", "+1", " 1", "0xff", "1_000"]) {
    assert.throws(() => toUsd(value), /Not a decimal/);
    assert.throws(() => compareDecimal(value, "1"), /Not a decimal/);
    assert.throws(() => compareDecimal("1", value), /Not a decimal/);
  }
});
