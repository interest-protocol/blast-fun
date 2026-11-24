import assert from "node:assert/strict";
import test from "node:test";
import { fetchPortfolioCoins, isCoin, isPortfolioCoinPage, isSocialPortfolio } from "./portfolio-client.ts";
import { PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";

test("preferred coins without holdings load through the portfolio API client", async (t) => {
  const coins = PREFERRED_COINS.map((coin) => ({
    coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals,
    balance: "0", value_usd: "0.00", icon_url: coin.logoUrl, presale_id: null,
  }));
  const page = { total: coins.length, page: 1, page_size: 20, coins };
  t.mock.method(globalThis, "fetch", async () => Response.json(page));

  const result = await fetchPortfolioCoins({ getAccessToken: async () => null, page: 1, search: "" });
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.body, page);
  assert.ok(!isCoin(coins[0]), "held portfolio coins still require a positive balance");
});

test("coin page boundary rejects invalid counts, missing rows and malformed amounts", () => {
  const coin = { coin_type: "0x2::coin::COIN", symbol: "COIN", name: null, decimals: 9, balance: "1", value_usd: "1.00", icon_url: null, presale_id: null };
  const page = { total: 1, page: 1, page_size: 20, coins: [coin] };
  assert.ok(isPortfolioCoinPage(page));
  assert.ok(isPortfolioCoinPage({ total: 0, page: 1, page_size: 20, coins: [] }));
  for (const bad of [{ ...page, total: -1 }, { ...page, page: 0 }, { ...page, page: 2 }, { ...page, page_size: 100 }, { ...page, coins: [] }, { ...page, coins: [{ ...coin, balance: "-1" }] }, { ...page, coins: [{ ...coin, value_usd: "1" }] }, { ...page, coins: [{ ...coin, decimals: 256 }] }]) assert.ok(!isPortfolioCoinPage(bad));
});

test("compact summary validates its optional figures at the response boundary", () => {
  const portfolio = { balances: null, positions: [], commitments: null, coins: [], vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: [], coin_summary: { value_usd: null, known_value_usd: "0.00", today: null } };
  assert.ok(isSocialPortfolio(portfolio));
  assert.ok(!isSocialPortfolio({ ...portfolio, coin_summary: { ...portfolio.coin_summary, today: { usd: Infinity, pct: 1 } } }));
  assert.ok(!isSocialPortfolio({ ...portfolio, coin_summary: { ...portfolio.coin_summary, known_value_usd: null } }));
});

test("position subtotal fields are additive and reject malformed known USD amounts", () => {
  const portfolio = { balances: null, positions: [], commitments: { committed_usd: null, claimable_usd: null }, coins: [], vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: [] };
  assert.ok(isSocialPortfolio(portfolio), "older responses without the additive fields remain valid");
  const commitments = { ...portfolio.commitments, known_committed_usd: "100.00", known_claimable_usd: "5.00" };
  assert.ok(isSocialPortfolio({ ...portfolio, commitments }));
  for (const field of ["known_committed_usd", "known_claimable_usd"]) {
    for (const invalid of [null, "1", "-1.00", 100]) assert.ok(!isSocialPortfolio({ ...portfolio, commitments: { ...commitments, [field]: invalid } }));
  }
});

test("a coin page row may carry its Blast launch id: absent, null or text, never another type", () => {
  const coin = { coin_type: "0x2::coin::COIN", symbol: "COIN", name: null, decimals: 9, balance: "1", value_usd: "1.00", icon_url: null, presale_id: null };
  const page = (row: object) => ({ total: 1, page: 1, page_size: 20, coins: [row] });
  for (const launch of [{}, { launch_id: null }, { launch_id: `0x${"a".repeat(64)}` }]) assert.ok(isPortfolioCoinPage(page({ ...coin, ...launch })));
  for (const launch_id of [7, {}, true]) assert.ok(!isPortfolioCoinPage(page({ ...coin, launch_id })));
});
