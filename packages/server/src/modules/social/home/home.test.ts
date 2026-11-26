import assert from "node:assert/strict";
import test from "node:test";

import { HOME_DEFAULT_QUERY, type HomeActivity, type HomeParticipant } from "@blast/core/modules/social/contracts/home.ts";
import { homeCoinSchema } from "@blast/core/modules/social/contracts/home-schemas.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { activityOf, addDecimal, amountOf, countsOf, participantOf, previewOf, quoteAssetOf, shareBps, sideAcross, sideOf, totalsOf } from "@blast/server/modules/social/home/aggregate.ts";
import { decodeCursor, encodeCursor } from "@blast/server/modules/social/home/codec.ts";
import { newHoldersOf, topHoldersOf } from "@blast/server/modules/social/home/coins.ts";
import { fdvOf } from "@blast/server/modules/social/home/fdv.ts";
import { decodeHomeCursor, encodeHomeCursor, homeOrder, pageOf, parseHomeQuery, passesFilters, rankInputs, recencyOf, relevanceScore, whyShown, type Rankable } from "@blast/server/modules/social/home/rank.ts";
import type { GroupedRow, SideRow } from "@blast/server/modules/social/home/sql.ts";
import { eventOf, parseThreadQuery } from "@blast/server/modules/social/home/thread.ts";
import { traderPortfolioOf } from "@blast/server/modules/social/home/traders.ts";
import { lifetimePnl } from "@blast/server/modules/social/portfolio/pnl.ts";
import type { CostBasisRow } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import type { WalletHolding, WalletHoldings, WalletSync } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import { hex } from "../../../../../core/test/kit.ts";

const invalid = { code: "invalid_parameter" };

/** The pure parts of Home: amounts, grouping, previews, ranking, cursors and the query. */

const QUOTE = `${hex("dba3")}::usdc::USDC`;
const SALE = hex("5a1e");
const sale = { sale_quote: QUOTE, sale_quote_symbol: "USDC", sale_quote_decimals: 6 };

function side(over: Partial<SideRow>): SideRow {
  return { sale: SALE, who: "w:" + hex("a1"), kind: "trade_buy", quote_type: QUOTE, ...sale, n: "1", atoms: "1000000", usd: "1.00", unpriced: "0", tokens: "500", latest_ms: "1000", ...over };
}

test("quote assets: the sale's quote, SUI and USDC by type; anything else keeps its atoms but no name", () => {
  assert.deepEqual(quoteAssetOf(QUOTE, sale), { symbol: "USDC", decimals: 6 });
  assert.deepEqual(quoteAssetOf(SOCIAL_TRADE_BASE_COINS.sui, sale), { symbol: "SUI", decimals: 9 });
  assert.deepEqual(quoteAssetOf(`${hex("ab")}::x::X`, sale), { symbol: null, decimals: null });
});

test("the trade list can request indexed USD precision without changing default thread values", () => {
  const params = new URLSearchParams({ presale: SALE });
  const row = {
    who: "w:" + hex("a1"), activity_id: "1:0:0:0", kind: "trade_buy", timestamp_ms: "1000", digest: null,
    quote_type: SOCIAL_TRADE_BASE_COINS.sui, ...sale, quote_amount: "250000000", coin_amount: "500",
    quote_refund: null, usd_value: "0.999", has_why: false,
  };
  assert.equal(eventOf(row, parseThreadQuery(params).exactTradeUsd)?.quote?.usd, "1.00");
  params.set("exact_trade_usd", "1");
  assert.equal(eventOf(row, parseThreadQuery(params).exactTradeUsd)?.quote?.usd, "0.999");
});

test("amounts: USD only as priced, never 0 for the unpriced; different quote assets are never summed", () => {
  const priced = amountOf(side({ atoms: "2500000", usd: "2.50", unpriced: "0" }));
  assert.deepEqual(priced, { quote_type: QUOTE, quote_symbol: "USDC", quote_decimals: 6, atoms: "2500000", usd: "2.50", usd_complete: true });
  const unpriced = amountOf(side({ usd: null, unpriced: "2", n: "2" }));
  assert.equal(unpriced.usd, null);
  assert.equal(unpriced.usd_complete, false);
  const partial = amountOf(side({ usd: "1.5", unpriced: "1", n: "2" }));
  assert.deepEqual([partial.usd, partial.usd_complete], ["1.50", false]);
  const mixed = sideOf([
    side({ atoms: "1000000", usd: "1.00" }),
    side({ quote_type: SOCIAL_TRADE_BASE_COINS.sui, atoms: "3000000000", usd: "9.00", tokens: "10", latest_ms: "2000" }),
  ]);
  assert.ok(mixed);
  assert.equal(mixed.amounts.length, 2);
  assert.deepEqual(mixed.amounts.map((amount) => [amount.quote_symbol, amount.atoms]), [["USDC", "1000000"], ["SUI", "3000000000"]]);
  assert.deepEqual([mixed.count, mixed.tokens, mixed.latest_ms], [2, "510", 2000]);
  assert.equal(sideOf([]), null);
});

test("totals add the same asset exactly across identities and keep the sale's quote first", () => {
  const totals = totalsOf([
    side({ who: "a:1", atoms: "1", usd: "0.01" }),
    side({ who: "a:2", atoms: "2", usd: "0.02", unpriced: "0" }),
    side({ who: "a:3", quote_type: SOCIAL_TRADE_BASE_COINS.sui, atoms: "5", usd: null, unpriced: "1" }),
    side({ who: "a:4", atoms: "99999999999999999999", usd: "123456789.995" }),
  ]);
  assert.deepEqual(totals.map((amount) => [amount.quote_symbol, amount.atoms, amount.usd, amount.usd_complete]), [
    ["USDC", "100000000000000000002", "123456790.03", true],
    ["SUI", "5", null, false],
  ]);
  assert.equal(addDecimal("0.1", "0.2"), "0.3");
  assert.equal(addDecimal("1", "0.005"), "1.005");
});

const grouped = (over: Partial<GroupedRow>): GroupedRow => ({ sale: SALE, who: "w:" + hex("a1"), account_id: null, wallet: hex("a1"), events_total: "3", latest_ms: "5000", latest_kind: "trade_sell", ...over });

test("a participant keeps buying and selling apart; a named account is one identity with a follower count only when known", () => {
  const identities = new Map([["00000000-0000-4000-8000-000000000001", { account_id: "00000000-0000-4000-8000-000000000001", callsign: "maya", display_name: "Maya", avatar_url: null, x_handle: null, verified: true }]]);
  const maya = participantOf({
    grouped: grouped({ who: "a:00000000-0000-4000-8000-000000000001", account_id: "00000000-0000-4000-8000-000000000001", events_total: "4", latest_kind: "trade_sell" }),
    sides: [
      side({ who: "a:00000000-0000-4000-8000-000000000001", kind: "trade_buy", n: "3", atoms: "300000000", usd: "300.00", tokens: "24000", latest_ms: "4000" }),
      side({ who: "a:00000000-0000-4000-8000-000000000001", kind: "trade_sell", n: "1", atoms: "40000000", usd: "40.00", tokens: "8000", latest_ms: "5000" }),
    ],
    identities,
    followers: new Map(),
  });
  assert.equal(maya.key, "c:maya");
  assert.equal(maya.actor.type, "account");
  assert.equal(maya.followers, null);
  assert.deepEqual([maya.buys?.count, maya.buys?.amounts[0]?.atoms, maya.sells?.count, maya.sells?.amounts[0]?.atoms], [3, "300000000", 1, "40000000"]);
  assert.equal(maya.commits, null);
  assert.equal(maya.latest_kind, "trade_sell");
  const wallet = participantOf({ grouped: grouped({}), sides: [side({})], identities, followers: new Map([["x", 3]]) });
  assert.equal(wallet.key, `w:${hex("a1")}`);
  assert.deepEqual(wallet.actor, { type: "address", address: hex("a1"), short: "0x0000…00a1" });
  assert.equal(wallet.followers, null);
});

test("counts: distinct identities overall and per direction; one actor's repeats are one participant", () => {
  const counts = countsOf([
    side({ who: "a:1", kind: "trade_buy", n: "4" }),
    side({ who: "a:1", kind: "trade_sell", n: "1", latest_ms: "9000" }),
    side({ who: "w:2", kind: "trade_buy", n: "1" }),
    side({ who: "w:3", kind: "presale_commit", n: "2", latest_ms: "100" }),
  ]).get(SALE);
  assert.deepEqual(counts, { sale: SALE, participants: "3", events: "8", buyers: "2", sellers: "1", backers: "1", claimers: "0", latest_ms: "9000", last_trade_ms: "9000", volume_usd: "4.00", net_inflow_usd: "2.00" });
  assert.equal(countsOf([]).size, 0);
  // The last trade is a buy or a sell: a later commit or claim does not move it.
  const later = countsOf([
    side({ who: "a:1", kind: "trade_sell", latest_ms: "500" }),
    side({ who: "w:2", kind: "presale_commit", latest_ms: "900" }),
    side({ who: "w:3", kind: "presale_claim", latest_ms: "950" }),
  ]).get(SALE);
  assert.deepEqual([later?.latest_ms, later?.last_trade_ms], ["950", "500"]);
  assert.equal(countsOf([side({ who: "w:2", kind: "presale_commit", latest_ms: "900" })]).get(SALE)?.last_trade_ms, null);
  // Net inflow: buys and commits in, sells out, claims neither; it may go below zero. A claim is not volume either.
  const out = countsOf([
    side({ who: "a:1", kind: "trade_buy", usd: "10.50" }),
    side({ who: "a:1", kind: "trade_sell", usd: "25.00" }),
    side({ who: "w:2", kind: "presale_claim", usd: "99.00" }),
    side({ who: "w:3", kind: "trade_buy", usd: null }),
  ]).get(SALE);
  assert.deepEqual([out?.volume_usd, out?.net_inflow_usd], ["35.50", "-14.50"]);
});

const person = (key: string, latest: number, sells: boolean): HomeParticipant => ({
  key, actor: { type: "address", address: hex(key), short: key }, followers: null,
  buys: sells ? null : { count: 1, amounts: [], tokens: null, latest_ms: latest },
  sells: sells ? { count: 1, amounts: [], tokens: null, latest_ms: latest } : null,
  commits: null, claims: null, latest_ms: latest, latest_kind: sells ? "trade_sell" : "trade_buy", events_total: 1,
});

test("the preview is the newest rows, and a seller is kept when anyone sold", () => {
  const rows = [person("b1", 100, false), person("b2", 90, false), person("b3", 80, false), person("s1", 10, true)];
  assert.deepEqual(previewOf(rows).map((row) => row.key), ["b1", "b2", "s1"]);
  assert.deepEqual(previewOf(rows, 2).map((row) => row.key), ["b1", "s1"]);
  assert.deepEqual(previewOf(rows.slice(0, 3)).map((row) => row.key), ["b1", "b2", "b3"]);
  assert.deepEqual(previewOf([person("s9", 500, true), ...rows]).map((row) => row.key), ["s9", "b1", "b2"]);
  assert.deepEqual(previewOf([]), []);
});

const activity = (over: Partial<HomeActivity>): HomeActivity => activityOf({ scope: "pool", window: "24h", fromMs: 0, toMs: 86_400_000, counts: undefined, sides: [], preview: [] }) && {
  scope: "pool", window: "24h", from_ms: 0, to_ms: 86_400_000, participants: 0, events: 0, buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [], ...over,
};

test("ranking: breadth first, one actor capped at three events, recency in steps, missing data scores 0", () => {
  assert.deepEqual(rankInputs(activity({ participants: 4, events: 8, latest_ms: 86_400_000 - 60_000 })), { breadth: 4, activity: 8, recency: 2, volume: 0 });
  assert.equal(rankInputs({ ...activity({ participants: 1, events: 1, latest_ms: 1 }), volume_usd: "1234.50" }).volume, 1234.5);
  // A whale's 40 trades count as three; its breadth is one.
  assert.deepEqual(rankInputs(activity({ participants: 1, events: 40, latest_ms: 86_400_000 - 10 * 3_600_000 })), { breadth: 1, activity: 3, recency: 1, volume: 0 });
  const day = 86_400_000;
  assert.equal(relevanceScore({ inputs: rankInputs(activity({})), latestMs: null }, "24h", day), 0);
  // Every input at its cap, traded this moment: the full 100, stored ×100.
  assert.equal(relevanceScore({ inputs: { breadth: 50, volume: 20_000 }, latestMs: day, holders: 1_000, netInflow: 10_000, newHolders: 50 }, "24h", day), 10_000);
  assert.equal(relevanceScore({ inputs: { breadth: 500, volume: 1e9 }, latestMs: day + 5, holders: 1e6, netInflow: 1e9, newHolders: 1e6 }, "24h", day), 10_000);
  // Ten traders with $500 between them beat one wallet's $20,000 at the same moment.
  const crowd = relevanceScore({ inputs: { breadth: 10, volume: 500 }, latestMs: day, holders: 0 }, "24h", day);
  const whaleOnly = relevanceScore({ inputs: { breadth: 1, volume: 20_000 }, latestMs: day, holders: 0 }, "24h", day);
  assert.ok(crowd > whaleOnly, `${crowd} > ${whaleOnly}`);
  // Freshness halves at half the window; a coin with no window activity ranks by holders alone.
  assert.equal(relevanceScore({ inputs: { breadth: 0, volume: 0 }, latestMs: day / 2, holders: 0 }, "24h", day), 750);
  assert.equal(relevanceScore({ inputs: { breadth: 0, volume: 0 }, latestMs: null, holders: 1_000 }, "24h", day), 500);
  // Churn: one wallet buying and selling $20,000 in a loop, with no money left in and no new holder,
  // ranks below five buyers who put $500 in and stayed.
  const churn = relevanceScore({ inputs: { breadth: 1, volume: 20_000 }, latestMs: day, holders: 100, netInflow: 0, newHolders: 0 }, "24h", day);
  const buyers = relevanceScore({ inputs: { breadth: 5, volume: 500 }, latestMs: day, holders: 100, netInflow: 500, newHolders: 5 }, "24h", day);
  assert.ok(buyers > churn, `${buyers} > ${churn}`);
  // Same trades, same people: the coin that gained holders and kept the money ranks higher; a net outflow counts as none.
  const kept = relevanceScore({ inputs: { breadth: 5, volume: 500 }, latestMs: day, holders: 100, netInflow: 400, newHolders: 4 }, "24h", day);
  const left = relevanceScore({ inputs: { breadth: 5, volume: 500 }, latestMs: day, holders: 100, netInflow: -400, newHolders: 0 }, "24h", day);
  assert.ok(kept > left, `${kept} > ${left}`);
  assert.equal(left, relevanceScore({ inputs: { breadth: 5, volume: 500 }, latestMs: day, holders: 100 }, "24h", day));
  // New holders: now less the window's start; a coin launched inside the window started from none; anything unknown gains 0.
  const holderFacts = (holders: string | null, start: string | null, launched: string | null) => ({ holders, holders_at_start: start, launched_ms: launched });
  assert.equal(newHoldersOf(holderFacts("120", "100", "1"), { fromMs: 1_000 }), 20);
  assert.equal(newHoldersOf(holderFacts("90", "100", "1"), { fromMs: 1_000 }), 0);
  assert.equal(newHoldersOf(holderFacts("30", null, "5000"), { fromMs: 1_000 }), 30);
  assert.equal(newHoldersOf(holderFacts("30", null, "1"), { fromMs: 1_000 }), 0);
  assert.equal(newHoldersOf(holderFacts("30", null, null), { fromMs: 1_000 }), 0);
  assert.equal(newHoldersOf(holderFacts(null, "10", "5000"), { fromMs: 1_000 }), 0);
  // The clock ticks once a minute for every coin: within a minute a score holds still, and two coins
  // keep the same gap across ticks, even while one traded within the current minute, so they never swap on their own.
  const at = 36_000_000;
  const fresh = (latestMs: number, toMs: number) => relevanceScore({ inputs: { breadth: 0, volume: 0 }, latestMs, holders: 0 }, "1h", toMs);
  const gaps = [95_000, 110_000, 130_000, 185_000].map(offset => fresh(at + 108_000, at + offset) - fresh(at + 36_000, at + offset));
  assert.deepEqual(gaps, [30, 30, 30, 30]);
  assert.equal(fresh(at, at + 120_001), fresh(at, at + 180_000));
  assert.equal(recencyOf(null, "1h", 10_000_000), 0);
  assert.equal(recencyOf(10_000_000 - 300_000, "1h", 10_000_000), 2);
  assert.equal(recencyOf(10_000_000 - 1_500_000, "1h", 10_000_000), 1);
  assert.equal(recencyOf(10_000_000 - 3_000_000, "1h", 10_000_000), 0);
  // A sale coin's trades count on every venue, so its line names no single pool.
  assert.equal(whyShown(activity({ participants: 4, events: 8, buyers: 3, sellers: 1 }), "every_venue"), "4 participants · 8 trades · 1 sold in the last 24h");
  assert.equal(whyShown(activity({ participants: 1, events: 1, backers: 1, window: "1h" }), "every_venue"), "1 participant · 1 commitment in the last hour");
  assert.equal(whyShown(activity({ participants: 2, events: 5, backers: 1, buyers: 1 }), "every_venue"), "2 participants · 5 events in the last 24h");
  assert.equal(whyShown(activity({}), "every_venue"), "No activity in the last 24h");
  // A standalone vault coin's trades are its registered pool's only, and its line says so.
  assert.equal(whyShown(activity({ participants: 1, events: 1, buyers: 1 }), "own_pool"), "1 participant · 1 trade in the last 24h in its pool");
  assert.equal(whyShown(activity({ window: "1h" }), "own_pool"), "No activity in the last hour in its pool");
});

const rankable = (coinType: string, over: Partial<Rankable>): Rankable => ({ coinType, score: 0, inputs: { breadth: 0, activity: 0, recency: 0, volume: 0 }, latestMs: null, launchedMs: null, ...over });

test("orders are total and deterministic; paging skips the cursor's position and never repeats a coin", () => {
  const a = rankable("a", { score: 58, inputs: { breadth: 4, activity: 8, recency: 2, volume: 0 }, latestMs: 900, launchedMs: 1 });
  const b = rankable("b", { score: 58, inputs: { breadth: 4, activity: 8, recency: 2, volume: 0 }, latestMs: 950, launchedMs: 2 });
  const c = rankable("c", { score: 13, inputs: { breadth: 1, activity: 3, recency: 0, volume: 0 }, latestMs: 100, launchedMs: 3 });
  const d = rankable("d", { launchedMs: 9 });
  const e = rankable("e", { launchedMs: 9 });
  const ordered = [a, b, c, d, e].sort(homeOrder("relevant")).map((row) => row.coinType);
  assert.deepEqual(ordered, ["b", "a", "c", "d", "e"]);
  assert.deepEqual([e, d, c, b, a].sort(homeOrder("newest")).map((row) => row.coinType), ["d", "e", "c", "b", "a"]);
  assert.deepEqual([e, d, c, b, a].sort(homeOrder("trending")).map((row) => row.coinType), ["b", "a", "c", "d", "e"]);
  // Trending: the window's dollars first (one wallet's $900 outranks four people's $0), breadth next.
  const whale = rankable("w", { score: 13, inputs: { breadth: 1, activity: 3, recency: 0, volume: 900 }, latestMs: 50 });
  assert.deepEqual([a, whale, c].sort(homeOrder("trending")).map((row) => row.coinType), ["w", "a", "c"]);
  const first = pageOf([a, b, c, d, e], "relevant", null, 2);
  assert.deepEqual(first.page.map((row) => row.coinType), ["b", "a"]);
  assert.ok(first.nextCursor);
  const second = pageOf([a, b, c, d, e], "relevant", decodeHomeCursor(first.nextCursor!, "relevant"), 2);
  assert.deepEqual(second.page.map((row) => row.coinType), ["c", "d"]);
  const third = pageOf([a, b, c, d, e], "relevant", decodeHomeCursor(second.nextCursor!, "relevant"), 2);
  assert.deepEqual([third.page.map((row) => row.coinType), third.nextCursor], [["e"], null]);
  // Numbered pages over the same order: the page asked for, how many there are, how many coins in all; past the end, an empty page.
  assert.deepEqual([first.pageNumber, first.pages, first.total], [1, 3, 5]);
  const numbered = pageOf([a, b, c, d, e], "relevant", null, 2, 2);
  assert.deepEqual([numbered.page.map((row) => row.coinType), numbered.pageNumber, numbered.pages, numbered.total], [["c", "d"], 2, 3, 5]);
  assert.ok(numbered.nextCursor);
  const lastPage = pageOf([a, b, c, d, e], "relevant", null, 2, 3);
  assert.deepEqual([lastPage.page.map((row) => row.coinType), lastPage.nextCursor], [["e"], null]);
  assert.deepEqual([pageOf([a, b, c, d, e], "relevant", null, 2, 4).page, pageOf([], "relevant", null, 2).pages], [[], 1]);
  // `ranked`: the coins with data on the sort's keys, which lead its order (Trending: window activity; New: a launch time).
  assert.deepEqual(["trending", "newest", "relevant", "held"].map((sort) => pageOf([a, b, c, d, e, whale], sort as "trending", null, 2, 3).ranked), [4, 5, 4, 0]);
  // A coin that rose above the cursor since the last read is skipped, not shown twice.
  const risen = { ...c, score: 100 };
  assert.deepEqual(pageOf([a, b, risen, d, e], "relevant", decodeHomeCursor(first.nextCursor!, "relevant"), 2).page.map((row) => row.coinType), ["d", "e"]);
  assert.throws(() => decodeHomeCursor(first.nextCursor!, "newest"), invalid);
  assert.throws(() => decodeHomeCursor(`${first.nextCursor!}x`, "relevant"), invalid);
  assert.throws(() => decodeHomeCursor("", "relevant"), invalid);
  const round = encodeHomeCursor({ sort: "newest", coinType: "z::z::Z", score: 0, breadth: 0, activity: 0, recency: 0, volume: 12.5, latestMs: null, launchedMs: 5 });
  assert.equal(decodeHomeCursor(round, "newest").volume, 12.5);
  assert.deepEqual(decodeHomeCursor(round, "newest").launchedMs, 5);
});

test("filters: unknown data never passes a numeric filter", () => {
  const query = { ...HOME_DEFAULT_QUERY, minParticipants: 2, age: "7d" as const, tradable: true };
  const now = 100 * 86_400_000;
  assert.equal(passesFilters(query, { participants: 2, launchedMs: now - 86_400_000, tradable: true, knownDeployer: false, listed: true, progressBps: null, nowMs: now }), true);
  assert.equal(passesFilters(query, { participants: 1, launchedMs: now - 86_400_000, tradable: true, knownDeployer: false, listed: true, progressBps: null, nowMs: now }), false);
  assert.equal(passesFilters(query, { participants: 2, launchedMs: null, tradable: true, knownDeployer: false, listed: true, progressBps: null, nowMs: now }), false);
  assert.equal(passesFilters(query, { participants: 2, launchedMs: now - 8 * 86_400_000, tradable: true, knownDeployer: false, listed: true, progressBps: null, nowMs: now }), false);
  assert.equal(passesFilters(query, { participants: 2, launchedMs: now - 86_400_000, tradable: false, knownDeployer: false, listed: true, progressBps: null, nowMs: now }), false);
  assert.equal(passesFilters(HOME_DEFAULT_QUERY, { participants: 0, launchedMs: null, tradable: false, knownDeployer: false, listed: true, progressBps: null, nowMs: now }), true);
});

test("filters: Known deployer only keeps the coins with the badge", () => {
  const query = { ...HOME_DEFAULT_QUERY, knownDeployer: true };
  const candidate = { participants: 0, launchedMs: null, tradable: false, knownDeployer: false, listed: true, progressBps: null, nowMs: 0 };
  assert.equal(passesFilters(query, { ...candidate, knownDeployer: true }), true);
  assert.equal(passesFilters(query, candidate), false);
  assert.equal(passesFilters(HOME_DEFAULT_QUERY, candidate), true);
});

test("the query: defaults, each parameter once, malformed ranges refused rather than clamped", () => {
  assert.deepEqual(parseHomeQuery(new URLSearchParams("")), HOME_DEFAULT_QUERY);
  assert.deepEqual(parseHomeQuery(new URLSearchParams("window=1h&sort=newest&min_participants=3&age=7d&tradable=1&known_deployer=1&limit=5&page=4")), { window: "1h", sort: "newest", stage: "all", minParticipants: 3, age: "7d", tradable: true, knownDeployer: true, limit: 5, page: 4, cursor: null });
  assert.equal(parseHomeQuery(new URLSearchParams("limit=50")).limit, 50);
  // `ranked=1` asks for the count; without it the query (and so the answer and cache key) is unchanged.
  assert.equal(parseHomeQuery(new URLSearchParams("sort=trending&ranked=1")).ranked, true);
  assert.equal("ranked" in parseHomeQuery(new URLSearchParams("ranked=0")), false);
  for (const bad of ["ranked=yes", "ranked=1&ranked=1", "window=2h", "sort=cap", "min_participants=-1", "min_participants=1.5", "min_participants=99999999", "age=1d", "tradable=yes", "known_deployer=yes", "known_deployer=1&known_deployer=1", "limit=0", "limit=51", "limit=abc", "window=1h&window=24h", "cursor=", "page=0", "page=1.5", "page=10000", "page=x", "page=2&cursor=abc"]) {
    assert.throws(() => parseHomeQuery(new URLSearchParams(bad)), invalid, bad);
  }
});

test("FDV: price × supply ÷ 10^decimals to two places, exact; null without a price or supply", () => {
  assert.equal(fdvOf("0.0789", "1000000000000000000", 9), "78900000.00");
  assert.equal(fdvOf("2", "1500000000", 9), "3.00");
  assert.equal(fdvOf("0.005", "1", 0), "0.01");
  assert.equal(fdvOf("0.004", "1", 0), "0.00");
  assert.equal(fdvOf(null, "1", 0), null);
  assert.equal(fdvOf("1", null, 0), null);
  assert.equal(fdvOf("1e3", "1", 0), null);
});

test("cursor codec: a tag's cursor only, checked", () => {
  const cursor = encodeCursor("thread", [1, 5, "c:maya"]);
  assert.deepEqual(decodeCursor("thread", cursor), [1, 5, "c:maya"]);
  assert.throws(() => decodeCursor("following", cursor), invalid);
  assert.throws(() => decodeCursor("thread", cursor.slice(0, -1)), invalid);
});


test("a holder's share of the supply: basis points floored, null without a supply or above it", () => {
  assert.equal(shareBps("5000000000000", "1000000000000000"), 50);
  assert.equal(shareBps("60000000000", "1000000000000000"), 0);
  assert.equal(shareBps("1", null), null);
  assert.equal(shareBps("1", "0"), null);
  assert.equal(shareBps("1000000000000000", "1000000000000000"), 10000);
  assert.equal(shareBps("1000000000000001", "1000000000000000"), null);
});

test("top holders who together hold more than the live supply: each share stands, the total is unknown, and the contract accepts it", () => {
  // A supply below what the top holders hold together (ZTB live: 12785 bps, when 0x0 was counted).
  const row = (who: string, balance: string) => ({ coin_type: "0x1::ztb::ZTB", who: `w:${who}`, account_id: null, wallet: hex(who), balance });
  const top = topHoldersOf([row("1", "700"), row("2", "600")], "1000", new Map());
  assert.deepEqual([top.holders.map((holder) => holder.share_bps), top.share_bps], [[7000, 6000], null]);
  homeCoinSchema.shape.top_holders.parse(top);
});

test("a direction across coins: the same asset merged exactly, the counts and tokens added, the latest time kept; null for nothing", () => {
  const row = (sale: string, atoms: string, usd: string | null, n = "1", tokens: string | null = "1000", latest = "10"): SideRow =>
    ({ sale, who: "a:1", kind: "trade_buy", quote_type: SOCIAL_TRADE_BASE_COINS.usdc, sale_quote: SOCIAL_TRADE_BASE_COINS.usdc, sale_quote_symbol: "USDC", sale_quote_decimals: 6, n, atoms, usd, unpriced: usd === null ? n : "0", tokens, latest_ms: latest });
  assert.equal(sideAcross([]), null);
  const side = sideAcross([row("0xa", "100000000", "100.00", "3", "3000", "50"), row("0xb", "25000000", "25.00", "1", null, "80")]);
  assert.deepEqual([side?.count, side?.tokens, side?.latest_ms, side?.amounts.length], [4, "3000", 80, 1]);
  assert.deepEqual([side?.amounts[0]?.atoms, side?.amounts[0]?.usd, side?.amounts[0]?.usd_complete], ["125000000", "125.00", true]);
  assert.equal(sideAcross([row("0xa", "1", "1.00"), row("0xb", "1", null)])?.amounts[0]?.usd_complete, false);
});

test("a trader's portfolio: the value of its sale coins at fresh prices, and the profile's lifetime P&L total by the one cost-basis rule", () => {
  const now = 1_000_000;
  const holding = (balance: string, age = 10_000): WalletHolding => ({ coin_type: "0xs::coin::S", balance, name: null, icon_url: null, symbol: "S", decimals: 9, presale_id: "0xs", price: { usd_price: "0.05", as_of_ms: now - age }, priceUnavailable: false });
  const wallet = (holdings: readonly WalletHolding[], status: WalletSync["status"] = "ready"): WalletHoldings => ({ holdings, sync: { status, checkpoint: "1", as_of_ms: now } });
  const metadata = [{ presale_id: "0xs", coin_type: "0xs::coin::S", symbol: "S", icon_url: null, decimals: 9 }];
  const rows: CostBasisRow[] = [
    { kind: "trade_buy", presale_id: "0xs", actor: "0xa", quote_amount: "100000000", coin_amount: "2000000000000", quote_refund: null, usd_value: "100.00" },
    { kind: "trade_sell", presale_id: "0xs", actor: "0xa", quote_amount: "30000000", coin_amount: "500000000000", quote_refund: null, usd_value: "30.00" },
  ];
  const ledger = { rows, truncated: false };
  const held = wallet([holding("1500000000000")]);
  const portfolio = (coins: WalletHoldings, book = ledger) => traderPortfolioOf(coins, lifetimePnl(book, coins, metadata, now), now);
  // 2,000 bought for $100; 500 sold for $30 against a $25 cost (realised +$5); 1,500 held at $0.05 is $75 on a $75 basis.
  assert.deepEqual(portfolio(held), { public: true, value_usd: "75.00", pnl_usd: "5.00" });
  // A stale price: neither the value nor the unrealised part is known, so the total is not.
  assert.deepEqual(portfolio(wallet([holding("1500000000000", 600_000)])), { public: true, value_usd: null, pnl_usd: null });
  // Holdings the ledger never saw acquired carry no P&L (the profile's rule): $0.00, not unknown.
  assert.deepEqual(portfolio(held, { rows: [], truncated: false }), { public: true, value_usd: "75.00", pnl_usd: "0.00" });
  assert.deepEqual(portfolio(wallet([]), { rows: [], truncated: false }), { public: true, value_usd: "0.00", pnl_usd: "0.00" });
  // A cut-short ledger or a wallet still syncing: the history is incomplete, the total unknown; the value stands.
  assert.deepEqual(portfolio(held, { ...ledger, truncated: true }), { public: true, value_usd: "75.00", pnl_usd: null });
  assert.equal(portfolio(wallet([holding("1500000000000")], "syncing")).pnl_usd, null);
  // The same indexed trades in a linked external wallet retain their cost and proceeds.
  const outside = { rows: rows.map((row) => ({ ...row, actor: "external-wallet" })), truncated: false };
  assert.equal(portfolio(held, outside).pnl_usd, "5.00");
});
