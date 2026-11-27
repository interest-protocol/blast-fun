import assert from "node:assert/strict";
import test from "node:test";
import { minimumWeight, gasReserveFits, meetsPayoutMinimum, DAY_MS } from "./economics.ts";

test("the $10 holder threshold is inclusive and rounds fractional weights up", () => {
  const floor = minimumWeight({ numerator: 1n, denominator: 100n }, 10);
  assert.equal(999n * DAY_MS >= floor, false);
  assert.equal(1_000n * DAY_MS >= floor, true);
  assert.equal(1_001n * DAY_MS >= floor, true);
  assert.equal(minimumWeight({ numerator: 7n, denominator: 3n }, 10), 370_285_715n);
  assert.throws(() => minimumWeight({ numerator: 0n, denominator: 1n }, 10), /unavailable/);
});
test("gas reserve is at most a tenth of allocated holder Quote", () => {
  assert.equal(gasReserveFits(100n,1000n),true); assert.equal(gasReserveFits(101n,1000n),false);
  assert.equal(gasReserveFits(0n,0n),true); assert.equal(gasReserveFits(1n,0n),false);
});

test("the budget sums fractional USD from both fees and requires positive Quote", () => {
  const quote = { numerator: "199", denominator: "2", evidence: {} };
  const meme = { numerator: "2", denominator: "8", evidence: {} };
  assert.equal(meetsPayoutMinimum(1n, quote, 100, 2n, meme), true);
  assert.equal(meetsPayoutMinimum(1n, quote, 100, 1n, meme), false);
  assert.equal(meetsPayoutMinimum(0n, quote, 100, 500n, meme), false);
  assert.equal(meetsPayoutMinimum(1n, null, 100, 500n, meme), false);
  assert.equal(meetsPayoutMinimum(1n, quote, 100), false);
  assert.equal(meetsPayoutMinimum(2n, { numerator: "50", denominator: "1", evidence: {} }, 100), true);
});
