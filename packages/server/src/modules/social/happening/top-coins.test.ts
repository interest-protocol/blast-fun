import assert from "node:assert/strict";
import test from "node:test";
import type { HappeningCoin } from "@blast/core/modules/social/contracts/happening.ts";
import { rankTopCoins } from "@blast/server/modules/social/happening/top-coins.ts";

const coin = (key: string, buyers: number | null, holders: number | null, change: number | null): HappeningCoin => ({
  coin_type: key, presale_id: key === "sui" ? null : key, name: key, symbol: key, icon_url: null, price_usd: "1",
  change_24h_bps: change, buyers_24h: buyers, holders,
});
test("Trending uses buyer/holder ratio; Gainers excludes unknown, flat and negative moves", () => {
  const read = rankTopCoins([coin("large", 20, 100, -100), coin("small", 4, 10, 300), coin("sui", null, null, 500), coin("zero", 0, 0, null), coin("flat", 1, 10, 0)]);
  assert.deepEqual(read.trending.map((row) => row.coin_type), ["small", "large", "flat", "zero", "sui"]);
  assert.deepEqual(read.gainers.map((row) => row.coin_type), ["sui", "small"]);
  assert.deepEqual(rankTopCoins([]), { trending: [], gainers: [] });
  const many = rankTopCoins(Array.from({ length: 60 }, (_, i) => coin(String(i), i, 10, i)));
  assert.equal(many.trending.length, 50);
  assert.equal(many.gainers.length, 50);
});
