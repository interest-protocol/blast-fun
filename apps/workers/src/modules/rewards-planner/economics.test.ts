import assert from "node:assert/strict";
import test from "node:test";
import { qualifies, minimumWeight, gasReserveFits, DAY_MS } from "./economics.ts";

test("the $5 holder threshold uses the rational daily average without premature flooring", () => {
  const p={numerator:1n,denominator:1_000_000n}, threshold=5_000_000n*DAY_MS;
  assert.equal(qualifies(threshold-1n,p),false); assert.equal(qualifies(threshold,p),true);
  assert.throws(()=>qualifies(1n,{numerator:0n,denominator:1n}),/unavailable/);
  // The identity check's floor is exactly the smallest qualifying weight, rounding up.
  for (const q of [p,{numerator:3n,denominator:7n}]) { const m=minimumWeight(q); assert.equal(qualifies(m,q),true); assert.equal(qualifies(m-1n,q),false); }
});
test("gas reserve is at most a tenth of allocated holder Quote", () => {
  assert.equal(gasReserveFits(100n,1000n),true); assert.equal(gasReserveFits(101n,1000n),false);
  assert.equal(gasReserveFits(0n,0n),true); assert.equal(gasReserveFits(1n,0n),false);
});
