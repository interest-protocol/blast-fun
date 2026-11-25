import assert from "node:assert/strict";
import test from "node:test";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { INDEXED_POOL_COINS, indexedPoolCoin, isStandalonePool } from "./core-coins.ts";

test("SUI's page prices in USDC across its two allowlisted pools; community pools stay SUI-paired", () => {
  const sui = indexedPoolCoin("0x2::sui::SUI");
  assert.equal(sui?.quote.coinType, USDC_COIN_TYPE);
  assert.equal(sui?.quote.decimals, 6);
  assert.equal(sui?.major, true);
  assert.deepEqual(sui?.poolKeys.map((key) => key.split(":")[0]), ["cetus", "bluefin"]);
  assert.equal(sui?.poolKey, sui?.poolKeys[0]);
  for (const key of sui?.poolKeys ?? []) assert.ok(isStandalonePool(key));

  const one = INDEXED_POOL_COINS.find((coin) => coin.symbol === "ONE")!;
  const page = indexedPoolCoin(one.coinType);
  assert.equal(page?.quote.coinType, SUI_COIN_TYPE);
  assert.deepEqual(page?.poolKeys, [one.poolKey]);
  assert.ok(isStandalonePool(one.poolKey));

  assert.equal(INDEXED_POOL_COINS.some((coin) => coin.coinType === SUI_COIN_TYPE), false, "Home's pool list keeps SUI out");
  assert.equal(indexedPoolCoin(USDC_COIN_TYPE), undefined);
});
