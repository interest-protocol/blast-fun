import assert from "node:assert/strict";
import test from "node:test";
import { coinAmt, visibleHoldings } from "./coin-model.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";

test("holding search filters before ordering, handles unpriced balances, and never compares raw token quantities", () => {
  const base = FIXTURE_COINS[0]!;
  const rich = { ...base, coinType: "rich", symbol: "RICH", name: "Rich", atoms: 1000000n, decimals: 6, amount: 1, value: 1000 };
  const dust = { ...base, coinType: "dust", symbol: "DUST", name: "Dust", atoms: 999999n, decimals: 6, amount: .999999, value: 5000 };
  const unknown = { ...base, coinType: "unknown", name: "Unknown", value: null, atoms: 1n, metadataAvailable: false };
  assert.deepEqual(visibleHoldings([dust, unknown, rich], "", true).map(coin => coin.coinType), ["rich", "unknown"]);
  assert.deepEqual(visibleHoldings([dust, unknown, rich], "DUsT", false).map(coin => coin.coinType), ["dust"]);
  assert.deepEqual(visibleHoldings([rich, { ...rich, coinType: "aaa" }], "", true).map(coin => coin.coinType), ["aaa", "rich"]);
});


test("canonical small holdings remain visible in USD order and tiny amounts do not render as zero", () => {
  const core = { ...FIXTURE_COINS[0]!, atoms: 1n, amount: 0.000001, value: 0.01 };
  const fake = { ...core, coinType: "0x9::usdc::USDC" };
  const rich = { ...fake, atoms: 1000000n, amount: 1, value: 100000 };
  assert.deepEqual(visibleHoldings([rich, fake, core], "", true).map(coin => coin.coinType), [rich.coinType, core.coinType]);
  assert.deepEqual(visibleHoldings([{ ...core, value: null }, { ...rich, value: 0 }], "", true).map(coin => coin.coinType), [rich.coinType, core.coinType], "unpriced core holdings follow known zero USD values");
  assert.equal(coinAmt(core, core.amount), "<0.0001\u00a0USDC");
});
