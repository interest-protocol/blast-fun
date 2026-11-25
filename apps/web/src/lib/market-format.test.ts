import assert from "node:assert/strict";
import test from "node:test";
import { numberDecimal, readablePrice, readableUsd, subscriptZeros } from "./market-format";

test("financial summaries preserve sub-dollar amounts instead of rounding them to zero or one", () => {
  assert.equal(readableUsd("0.36"), "$0.36");
  assert.equal(readableUsd("0.54"), "$0.54");
  assert.equal(readableUsd("0"), "$0");
  assert.equal(readableUsd("0.000000000537"), "$0.0₉537");
  assert.equal(readableUsd("1234.56"), "$1.2K");
  assert.equal(readableUsd("12.34"), "$12.34");
  // Billions take a B, as the boards write them (Main board: `$1.84B`), never `$1840M`.
  assert.equal(readableUsd("1840000000"), "$1.84B");
  assert.equal(readableUsd("48200000"), "$48.2M");
  assert.equal(readableUsd("0.0000812"), "$0.0₄812");
});

test("compact prices retain leading-zero count and significant digits without floating-point conversion", () => {
  assert.equal(readablePrice("0.00000000000000000012345"), "0.0₁₈123");
  assert.equal(readablePrice("0.0000000009999"), "0.0₈1");
  // The boards' subscript starts at four leading zeros: `$0.0₄812`; three stay plain.
  assert.equal(readablePrice("0.0000812"), "0.0₄812");
  assert.equal(readablePrice("0.000088098231292"), "0.0₄881");
  assert.equal(readablePrice("0.000556"), "0.000556");
  assert.equal(readablePrice("0.36"), "0.36");
  assert.equal(
    readablePrice("9007199254740993.12"),
    "9,007,199,254,740,993.12",
  );
  assert.equal(readablePrice("unknown"), "—");
});

test("tiny decimals share one subscript form and never print in exponent form", () => {
  assert.equal(subscriptZeros("0.00000000182"), "0.0₈182");
  assert.equal(subscriptZeros("0.0000123"), "0.0₄123");
  assert.equal(subscriptZeros("0.000123"), "0.000123");
  assert.equal(subscriptZeros("12.5"), "12.5");
  assert.equal(subscriptZeros("0." + "0".repeat(18) + "123"), "0.0₁₈123");
  for (const [value, expected] of [
    [1.2e-7, "0.00000012"], [6e-11, "0.00000000006"], [0.000182, "0.000182"],
    [42, "42"], [1.5, "1.5"], [1e21, "1000000000000000000000"], [-2.5e-7, "-0.00000025"], [0, "0"],
  ] as const) {
    assert.equal(numberDecimal(value), expected);
    assert.doesNotMatch(numberDecimal(value), /e/);
  }
});
