import assert from "node:assert/strict";
import test from "node:test";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { HOME_BIG_TRADE_USD, HOME_HOLDERS_DEFAULT, socialHomeChartTradesPath, socialHomeHoldersPath, socialHomeMarketPath } from "@blast/core/modules/social/contracts/coin-market.ts";
import { HOME_DEFAULT_QUERY } from "@blast/core/modules/social/contracts/home.ts";
import { parseChartTradesQuery } from "@blast/server/modules/social/home/chart-trades.ts";
import { averageEntryUsd, parseHoldersLimit } from "@blast/server/modules/social/home/holders.ts";
import { decimalDifference, parseMarketCoin, usdOfSides } from "@blast/server/modules/social/home/market.ts";
import { supplyOf } from "@blast/server/modules/social/home/fdv.ts";
import { encodeCursor } from "@blast/server/modules/social/home/codec.ts";
import { decodeHomeCursor, encodeHomeCursor, homeOrder, pageOf, parseHomeQuery, type Rankable } from "@blast/server/modules/social/home/rank.ts";

const COIN = `0x${"ab".repeat(32)}::coin::ORBIT`;
const invalid = (parameter: string) => (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter"
  && (error as SocialRouteError & { extra?: { parameter?: string } }).extra?.parameter === parameter;

test("gap 10: the window's dollar move is exact, signed and trimmed, never a float", () => {
  assert.equal(decimalDifference("0.0413", "0.04"), "0.0013");
  assert.equal(decimalDifference("0.04", "0.0413"), "-0.0013");
  assert.equal(decimalDifference("1", "1.000"), "0");
  assert.equal(decimalDifference("0.000000000000000001", "0"), "0.000000000000000001");
  assert.equal(decimalDifference("12.5", "0.25"), "12.25");
  assert.equal(decimalDifference(null, "1"), null);
  assert.equal(decimalDifference("1", null), null);
  assert.equal(decimalDifference("1e3", "1"), null);
});

test("gap 8: circulating supply is the total less what vesting still holds, never below zero", () => {
  assert.deepEqual(supplyOf("1000", "250"), { total: "1000", escrowed: "250", circulating: "750" });
  assert.deepEqual(supplyOf("1000", null), { total: "1000", escrowed: "0", circulating: "1000" });
  assert.deepEqual(supplyOf("1000", "1500"), { total: "1000", escrowed: "1500", circulating: "0" });
  assert.equal(supplyOf(null, "1"), null);
  assert.equal(supplyOf("-1", "0"), null);
});

test("gap 8: liquidity is both sides at their prices, summed exactly before it rounds, or nothing", () => {
  // 900,000 tokens (9 places) at $0.05 and 45,000 USDC (6 places) at $1.
  assert.equal(usdOfSides([["900000000000000", "0.05", 9], ["45000000000", "1", 6]]), "90000.00");
  // Each side is a third of a cent: rounded alone each is $0.00, summed exactly they are $0.01.
  assert.equal(usdOfSides([["1", "0.003333", 0], ["1", "0.003334", 0]]), "0.01");
  assert.equal(usdOfSides([["5", "0.001", 0]]), "0.01", "half a cent rounds up");
  assert.equal(usdOfSides([["0", "0.05", 9], ["0", "1", 6]]), "0.00");
  assert.equal(usdOfSides([["1", null, 0], ["1", "1", 0]]), null, "an unpriced side");
  assert.equal(usdOfSides([["-1", "1", 0]]), null);
  assert.equal(usdOfSides([["1", "1e3", 0]]), null);
  assert.equal(usdOfSides([["1", "1", -1]]), null);
});

test("the market and holders reads take one canonical coin type; holders' limit is bounded, never clamped", () => {
  assert.equal(parseMarketCoin(new URLSearchParams({ coin: "0x2::sui::SUI" })), `0x${"0".repeat(63)}2::sui::SUI`);
  assert.equal(parseMarketCoin(new URLSearchParams({ coin: COIN })), COIN);
  for (const bad of ["", "coin=nope", `coin=${COIN}&coin=${COIN}`]) assert.throws(() => parseMarketCoin(new URLSearchParams(bad)), invalid("coin"), bad);
  assert.equal(parseHoldersLimit(new URLSearchParams()), HOME_HOLDERS_DEFAULT);
  assert.equal(parseHoldersLimit(new URLSearchParams("limit=100")), 100);
  for (const bad of ["limit=0", "limit=101", "limit=1.5", "limit=x", "limit=5&limit=6"]) assert.throws(() => parseHoldersLimit(new URLSearchParams(bad)), invalid("limit"), bad);
  assert.equal(socialHomeMarketPath(COIN), `/api/social/home/market?coin=${encodeURIComponent(COIN)}`);
  assert.equal(socialHomeHoldersPath(COIN), `/api/social/home/holders?coin=${encodeURIComponent(COIN)}`);
  assert.equal(socialHomeHoldersPath(COIN, 100), `/api/social/home/holders?coin=${encodeURIComponent(COIN)}&limit=100`);
});

test("gap 7: a chart page is one span of at most 30 days, at least $1,000 for big trades", () => {
  const params = (extra: string) => new URLSearchParams(`coin=${encodeURIComponent(COIN)}&from_ms=1000&to_ms=5000${extra}`);
  assert.deepEqual(parseChartTradesQuery(params("")), { coinType: COIN, fromMs: 1000, toMs: 5000, minUsd: HOME_BIG_TRADE_USD });
  assert.equal(parseChartTradesQuery(params("&min_usd=25000")).minUsd, 25_000);
  assert.throws(() => parseChartTradesQuery(params("&min_usd=999")), invalid("min_usd"));
  assert.throws(() => parseChartTradesQuery(new URLSearchParams(`coin=${encodeURIComponent(COIN)}&from_ms=5000&to_ms=5000`)), invalid("from_ms"));
  assert.throws(() => parseChartTradesQuery(new URLSearchParams(`coin=${encodeURIComponent(COIN)}&from_ms=0&to_ms=${31 * 86_400_000}`)), invalid("from_ms"));
  assert.throws(() => parseChartTradesQuery(new URLSearchParams(`coin=${encodeURIComponent(COIN)}&to_ms=5000`)), invalid("from_ms"));
  assert.equal(socialHomeChartTradesPath(COIN, 1, 2, true), `/api/social/me/home/trades?coin=${encodeURIComponent(COIN)}&from_ms=1&to_ms=2`);
  // The viewer's own trades keep every trade: a `min_usd` there is refused, never silently ignored.
  assert.equal(parseChartTradesQuery(params(""), true).minUsd, HOME_BIG_TRADE_USD);
  assert.throws(() => parseChartTradesQuery(params("&min_usd=5000"), true), invalid("min_usd"));
});

test("gap 3: the average entry is the basis over the tokens held, twelve significant digits", () => {
  // $12.40 for 400 tokens of 9 decimals: 3.1 cents each.
  assert.equal(averageEntryUsd("12.40", "400000000000", 9), "0.031");
  assert.equal(averageEntryUsd("1.00", "3000000000", 9), "0.333333333333");
  assert.equal(averageEntryUsd("0.00", "1", 9), null);
  assert.equal(averageEntryUsd("12.4", "1", 9), null);
});

test("gap 6: `held` ranks the most holders first, a coin without a count last, and its cursor carries the count", () => {
  const rankable = (coinType: string, holders: number | null, volume = 0): Rankable => ({
    coinType, score: 0, inputs: { breadth: 0, activity: 0, recency: 0, volume }, latestMs: null, launchedMs: null, holders,
  });
  const coins = [rankable("a", 10), rankable("b", null), rankable("c", 40), rankable("d", 10, 5), rankable("e", 2)];
  assert.deepEqual([...coins].sort(homeOrder("held")).map((coin) => coin.coinType), ["c", "d", "a", "e", "b"]);
  const first = pageOf(coins, "held", null, 2);
  assert.deepEqual(first.page.map((coin) => coin.coinType), ["c", "d"]);
  const next = decodeHomeCursor(first.nextCursor!, "held");
  assert.equal(next.holders, 10);
  assert.deepEqual(pageOf(coins, "held", next, 2).page.map((coin) => coin.coinType), ["a", "e"]);
  assert.equal(parseHomeQuery(new URLSearchParams("sort=held")).sort, "held");
  assert.equal(HOME_DEFAULT_QUERY.sort, "relevant");
  // A cursor written before `held` (version 2) still reads for the other orders, never for `held`.
  const older = encodeCursor("discover", [2, "newest", "z::z::Z", 0, 0, 0, 0, 0, null, 5]);
  assert.deepEqual([decodeHomeCursor(older, "newest").launchedMs, decodeHomeCursor(older, "newest").holders], [5, null]);
  assert.throws(() => decodeHomeCursor(encodeCursor("discover", [2, "held", "z::z::Z", 0, 0, 0, 0, 0, null, 5]), "held"), invalid("cursor"));
  const encoded = encodeHomeCursor({ sort: "newest", coinType: "z::z::Z", score: 0, breadth: 0, activity: 0, recency: 0, volume: 0, latestMs: null, launchedMs: 5 });
  assert.equal(decodeHomeCursor(encoded, "newest").holders, null);
});
