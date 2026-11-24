import assert from "node:assert/strict";
import test from "node:test";
import type { PresaleTerms } from "@blast/core/modules/presale/terms/index.ts";
import { termsOf } from "./detail.ts";

const terms: PresaleTerms = {
  presaleId: `0x${"ab".repeat(32)}`,
  raiseTarget: "1000000",
  supply: {
    total: "2000000000000",
    participants: { bps: 5000, amount: "1000000000000" },
    liquidity: { bps: 5000, amount: "1000000000000" },
    recipients: [],
    protocol: { bps: 0, amount: "0" },
  },
  raise: { poolShare: "500000", recipients: [], protocol: { bps: 0, amount: "0" } },
  eligibility: { kind: "open" },
  burnable: false,
  hardCap: true,
};
const row = { target_usd: "0.00000005", sale_decimals: 9, quote_decimals: 6, raise_target: "1000000" };

test("presale terms serialize tiny USD prices as plain decimals at the published boundary", () => {
  const result = termsOf(terms, row, []);
  assert.equal(result.presale_price_usd, "0.00000000005");
  assert.equal(result.launch_price_usd, "0.000000000025");
});

test("presale USD prices retain twelve significant digits without exponent notation", () => {
  const rounded = termsOf(terms, { ...row, target_usd: "1234.5678901234" }, []);
  assert.equal(rounded.presale_price_usd, "1.23456789012");
  assert.equal(rounded.launch_price_usd, "0.617283945062");
  const large = termsOf(terms, { ...row, target_usd: "1000000000000000000000000000000" }, []);
  assert.equal(large.presale_price_usd, "1000000000000000000000000000");
  assert.equal(large.launch_price_usd, "500000000000000000000000000");
});

test("unavailable or non-finite USD prices remain null rather than invalid decimal strings", () => {
  for (const target_usd of [null, "0", "-1", "Infinity", "invalid", "5e-324"]) {
    const result = termsOf(terms, { ...row, target_usd }, []);
    assert.equal(result.presale_price_usd, null);
    assert.equal(result.launch_price_usd, null);
  }
});

test("gap 12: the launch FDV in the quote coin is the opening price times every token, exact from atoms", () => {
  // 1 USDC raised, half to the pool, against 1,000 of the 2,000 tokens: 0.0005 USDC each, 1 USDC for all 2,000.
  const result = termsOf(terms, row, []);
  assert.equal(result.launch_price_quote, "0.0005");
  assert.equal(result.launch_fdv_quote, "1");
  // A pool's share that does not divide evenly keeps twelve significant digits, never a float.
  const thirds = termsOf({ ...terms, supply: { ...terms.supply, liquidity: { bps: 5000, amount: "3000000000000" } } }, row, []);
  assert.equal(thirds.launch_fdv_quote, "0.333333333333");
  assert.equal(termsOf({ ...terms, supply: { ...terms.supply, total: "0" } }, row, []).launch_fdv_quote, null);
  // A pool share that is no whole basis point of the target: the terms' atoms, never floored to 3,333 bps first.
  const third = termsOf({ ...terms, raise: { ...terms.raise, poolShare: "333333" } }, row, []);
  assert.equal(third.launch_price_quote, "0.000333333");
  assert.equal(third.launch_fdv_quote, "0.666666");
});

test("parity: the trading fee is the terms' pool fee tier, null when the projection has none", () => {
  assert.equal(termsOf({ ...terms, poolFeePpm: 2_500 }, row, []).trading_fee_ppm, 2_500);
  assert.equal(termsOf({ ...terms, poolFeePpm: null }, row, []).trading_fee_ppm, null);
  assert.equal(termsOf(terms, row, []).trading_fee_ppm, null, "terms built without the field: unknown");
});
