import assert from "node:assert/strict";
import test from "node:test";
import { chartNumber, chartPrice } from "./chart-price";

for (const [value, expected] of [
  [null, "Unavailable"], [undefined, "Unavailable"], ["", "Unavailable"],
  ["NaN", "Unavailable"], ["-1", "Unavailable"], ["0.000", "0"],
  // Tiny: four or more leading zeros are counted in a subscript, as readablePrice writes them.
  ["0.00000000182", "0.0₈182"],
  ["0.000000000182345678", "0.0₉182345"],
  ["0." + "0".repeat(399) + "123456789", "0.0₃₉₉123456"],
  ["0.00001", "0.0₄1"], ["0.0000123456789", "0.0₄123456"], ["0.0000812", "0.0₄812"],
  // Normal.
  ["0.000199795432711782189195387208639779", "0.000199795"],
  ["0.0001", "0.0001"], ["12.300000", "12.3"], ["1000", "1000"],
  ["999999.987654321", "999999"],
  // Large: a suffix from a million; only magnitudes no price reaches keep an exponent.
  ["1000000", "1M"], ["1234567.89", "1.23456M"], ["98765432100", "98.7654B"],
  ["4200000000000", "4.2T"], ["1" + "0".repeat(399), "1e399"],
] as const) {
  test(`bounded chart price ${value} is ${expected}`, () => {
    const actual = chartPrice(value);
    assert.equal(actual, expected);
    assert.ok(actual.length <= 12);
    assert.doesNotMatch(actual, /e-/);
  });
}

test("tiny nonzero values stay distinct from zero without a floating-point conversion", () => {
  assert.notEqual(chartPrice("0." + "0".repeat(399) + "1"), chartPrice("0"));
  assert.notEqual(chartPrice("0.000199795432711782189195387208639779"), chartPrice("0.00022123456789123456789123456789"));
});

test("plotted numbers never print in exponent form", () => {
  for (const [value, expected] of [
    [1.2e-7, "0.0₆12"], [6e-11, "0.0₁₀6"], [0.000182, "0.000182"], [0.1 + 0.2, "0.3"],
    [42, "42"], [1_250_000, "1.25M"], [-0.5, "-0.5"], [0, "0"], [-0, "0"],
  ] as const) {
    const actual = chartNumber(value);
    assert.equal(actual, expected);
    assert.doesNotMatch(actual, /e/);
  }
  assert.equal(chartNumber(Number.NaN), "");
});
