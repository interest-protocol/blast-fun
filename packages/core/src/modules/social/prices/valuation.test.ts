import assert from "node:assert/strict";
import test from "node:test";
import { fdvOf, liveSupplyAtoms, marketCapRate } from "./valuation.ts";

test("live supply drops pending burns and the 0x0 balance, as Home's market cap does", () => {
  const inputs = { currencySupply: 1_000_000_000n, pendingBurnTotal: 25_000_000n, balance0x0: 175_000_000n };
  assert.equal(liveSupplyAtoms(inputs), 800_000_000n);
  assert.equal(liveSupplyAtoms({ ...inputs, balance0x0: 975_000_000n }), null);
  assert.equal(liveSupplyAtoms(null), null);
});

test("the market cap rate times a whole-token price is Home's market cap", () => {
  // 800M whole tokens (6 decimals) at 0.000025 SUI, SUI at $3.50: $70,000.
  const supply = 800_000_000_000_000n;
  const rate = marketCapRate("3.5", supply, 6);
  assert.equal(rate, "2800000000");
  assert.equal(Number(rate) * 0.000025, 70_000);
  assert.equal(fdvOf("0.0000875", supply.toString(), 6), "70000.00");
});

test("no rate, no supply or a zero leaves the market cap out", () => {
  assert.equal(marketCapRate(null, 1n, 0), null);
  assert.equal(marketCapRate("3.5", null, 6), null);
  assert.equal(marketCapRate("3.5", 0n, 6), null);
  assert.equal(marketCapRate("0", 5n, 0), null);
  assert.equal(marketCapRate("1", "1250000000", 9), "1.25");
});
