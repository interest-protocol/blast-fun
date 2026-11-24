import assert from "node:assert/strict";
import test from "node:test";
import { reimbursementAccumulator } from "./gas-settlement.ts";

test("gas settlement sums exact signed prices, offsets rebates, floors once and caps reimbursement", () => {
  const sum=reimbursementAccumulator(30n), usd={numerator:1n,denominator:1n};
  sum.add({digest:"1".repeat(32),netSuiAtoms:1n,suiUsd:{numerator:3n,denominator:2n},quoteUsd:usd});
  sum.add({digest:"2".repeat(32),netSuiAtoms:-1n,suiUsd:{numerator:1n,denominator:3n},quoteUsd:usd});
  assert.equal(sum.amount(),1n); assert.throws(()=>sum.add({digest:"1".repeat(32),netSuiAtoms:2n,suiUsd:usd,quoteUsd:usd}),/unordered/);
  sum.add({digest:"3".repeat(32),netSuiAtoms:100n,suiUsd:usd,quoteUsd:usd}); assert.equal(sum.amount(),30n);
});
