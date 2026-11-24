import assert from "node:assert/strict";
import test from "node:test";
import { legacyCoinMarket, legacyFdvUsd, trackedPoolMarketOf, trackedPoolPriceUsd } from "./legacy-fdv.ts";

test("values Wheels at the on-chain Bluefin close and rounds once after converting to USD", () => {
  const wheelsSupply = 981840660133807896n;
  const wheelsPrice = "62776416296676013";

  assert.equal(legacyFdvUsd(wheelsPrice, wheelsSupply, "2.5"), "28427.23");
  assert.equal(legacyFdvUsd(62776416296676013, wheelsSupply, "2.5"), null);
  assert.equal(legacyFdvUsd("x62776416296676013", wheelsSupply, "2.5"), null);
  assert.equal(legacyFdvUsd("62776416296676013x", wheelsSupply, "2.5"), null);
  assert.equal(legacyFdvUsd("340282366920938463463374607431768211456", wheelsSupply, "2.5"), null);
  assert.equal(legacyFdvUsd("0", wheelsSupply, "2.5"), null);
  assert.equal(legacyFdvUsd(wheelsPrice, wheelsSupply, "0"), null);
  assert.equal(legacyFdvUsd(wheelsPrice, wheelsSupply, "n/a"), null);
});

test("values circulating supply after subtracting the burn balance and keeps FDV separate", () => {
  const pool = { current_sqrt_price: "9223372036854775808" }; // 0.25 SUI per token
  const info = { supply: 4_000_000_000n, description: undefined };

  const { market, fdv } = legacyCoinMarket(pool, info, "1000000000", "2.5");
  assert.equal(market.circulatingSupplyAtoms, "3000000000");
  assert.equal(market.marketCapUsd, "1.875");
  assert.equal(fdv, "2.50");
  assert.equal(legacyCoinMarket(pool, info, "0", "2.5").market.marketCapUsd, "2.5");
  assert.equal(legacyCoinMarket(pool, info, "4000000000", "2.5").market.marketCapUsd, "0");
  assert.equal(legacyCoinMarket(pool, info, "4000000001", "2.5").market.marketCapUsd, undefined);
  assert.equal(legacyCoinMarket(pool, info, undefined, "2.5").market.marketCapUsd, undefined);
  assert.equal(legacyCoinMarket(pool, undefined, "0", "2.5").market.marketCapUsd, undefined);
});

test("quotes each whole tracked coin in USD using its own decimals", () => {
  const { market } = legacyCoinMarket({ current_sqrt_price: "9223372036854775808" }, undefined, undefined, null);
  assert.equal(trackedPoolPriceUsd(market.price, "2.5", 6), "0.000625");
  assert.equal(trackedPoolPriceUsd(market.price, "2.5", 9), "0.625");
  assert.equal(trackedPoolPriceUsd(market.price, null, 6), undefined);
  assert.equal(trackedPoolPriceUsd(market.price, "0", 6), undefined);
  assert.equal(trackedPoolPriceUsd(undefined, "2.5", 6), undefined);
});

test("tracked snapshots keep the older price observation and retain supply on price failure", () => {
  const info = { supply: 4_000_000n, description: undefined };
  const { market } = legacyCoinMarket({ current_sqrt_price: "9223372036854775808" }, info, "1000000", null);
  const sui = { priceUsd: "2.5", asOfMs: 1_000 };
  const supply = { totalSupplyAtoms: "4000000", circulatingSupplyAtoms: "3000000" };

  assert.deepEqual(trackedPoolMarketOf(market, 6, sui, 2_000), {
    ...supply,
    price: { priceUsd: "0.000625", asOfMs: 1_000 },
  });
  assert.deepEqual(trackedPoolMarketOf(market, 6, sui, 3_000)?.price, { priceUsd: "0.000625", asOfMs: 1_000 });
  assert.deepEqual(trackedPoolMarketOf(market, 6, sui, 900)?.price, { priceUsd: "0.000625", asOfMs: 900 });
  assert.deepEqual(trackedPoolMarketOf(market, 6, null, 2_000), { ...supply, price: undefined });
  assert.deepEqual(trackedPoolMarketOf(market, 6, sui, undefined), { ...supply, price: undefined });
  assert.deepEqual(trackedPoolMarketOf(supply, 6, sui, 2_000), { ...supply, price: undefined });
  assert.equal(trackedPoolMarketOf({}, 6, null, undefined), undefined);
});
