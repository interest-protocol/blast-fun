import assert from "node:assert/strict";
import test from "node:test";

import { HOME_DEFAULT_QUERY, HOME_NEW_LIMIT } from "@blast/core/modules/social/contracts/home.ts";
import { curveOf, homeDiscoverBaseKey, isBlastDust, raiseUsdOf } from "@blast/server/modules/social/home/coins.ts";
import { homeNewCoinSources } from "@blast/server/modules/social/home/sources.ts";
import { encodeCursor } from "@blast/server/modules/social/home/codec.ts";
import { decodeHomeCursor, encodeHomeCursor, HOME_DUST_USD, homeOrder, pageOf, passesFilters, type Rankable } from "@blast/server/modules/social/home/rank.ts";

const base = { tracked_pool_only: false, lifecycle: "migrated", raise_target: "0", quote_decimals: 9, quote_price_usd: "2" as string | null, raised: "0", graduation_target: null as string | null };
const sale = (raised: string, quotePrice: string | null = "2") => ({ ...base, presale_id: "0xsale", raised, quote_price_usd: quotePrice });
const curve = { ...base, presale_id: null };
const catalog = { ...curve, tracked_pool_only: true };
const dust = (facts: Parameters<typeof isBlastDust>[0], marketCapUsd: number | null, graduationTarget: string | null = null) => isBlastDust({ ...facts, graduation_target: graduationTarget ?? facts.graduation_target }, marketCapUsd);

test("dust: a raise (a sale's, or a curve's graduation target) or a market cap under $1,000; never catalog coins or unknown values", () => {
  // TETEMU: 0.55 SUI at $2 raised $1.10.
  assert.equal(raiseUsdOf(sale("550000000")), 1.1);
  assert.equal(dust(sale("550000000"), 1_000_000), true, "a big market cap does not rescue a sale that raised dust");
  // 500 SUI at $2 is exactly the threshold: kept.
  assert.equal(dust(sale("500000000000"), null), false);
  assert.equal(dust(sale("499999999999"), null), true);
  assert.equal(dust(sale("500000000000"), HOME_DUST_USD - 0.01), true, "a sale that raised enough but now trades under $1,000");
  assert.equal(dust(sale("1", null), null), false, "an unpriced quote is unknown, not small");
  // A curve that had to raise 400 SUI ($800) to graduate.
  assert.equal(raiseUsdOf({ ...curve, graduation_target: "400000000000" }), 800);
  assert.equal(dust(curve, 50_000, "400000000000"), true, "a low graduation target is dust whatever the coin trades at");
  assert.equal(dust(curve, HOME_DUST_USD, "8000000000000"), false);
  assert.equal(dust(curve, HOME_DUST_USD - 0.01, "8000000000000"), true);
  assert.equal(dust(curve, null), false, "a curve coin with no known target or market cap is unknown, not small");
  assert.equal(dust(catalog, 3, "1"), false, "catalog coins are not launched on Blast");
});

const idle = { breadth: 0, activity: 0, recency: 0, volume: 0 };
const rankable = (coinType: string, over: Partial<Rankable>): Rankable => ({ coinType, score: 0, inputs: idle, latestMs: null, launchedMs: null, ...over });

test("idle coins rank after active ones by FDV, then holders; never by holder count alone", () => {
  const active = rankable("nogas", { score: 2_500, inputs: { breadth: 3, activity: 5, recency: 2, volume: 120 }, latestMs: 900 });
  const dollarsOnly = rankable("catalog-dex", { score: 400, inputs: { ...idle, volume: 50 } });
  // A dead $3.20 coin with 8 holders scores on holders, yet sits below a $214K coin with no holder count.
  const dust = rankable("dust", { score: 903, holders: 8, fdvUsd: 3.2 });
  const manifest = rankable("manifest", { holders: null, fdvUsd: 214_000 });
  const wheels = rankable("wheels", { holders: null, fdvUsd: 9_000 });
  const heldNoFdv = rankable("held-no-fdv", { score: 1_000, holders: 1_000, fdvUsd: null });
  const nothing = rankable("nothing", {});
  const all = [nothing, heldNoFdv, dust, wheels, manifest, dollarsOnly, active];
  const expected = ["nogas", "catalog-dex", "manifest", "wheels", "dust", "held-no-fdv", "nothing"];
  assert.deepEqual([...all].sort(homeOrder("relevant")).map((row) => row.coinType), expected);
  // Trending's keys tie for idle coins; value breaks the tie the same way.
  assert.deepEqual([...all].sort(homeOrder("trending")).map((row) => row.coinType), expected);
  // Only the coin with nothing at all lacks Relevant data.
  assert.equal(pageOf(all, "relevant", null, 3).ranked, 6);

  // Keyset paging walks into and through the idle tier without repeats or gaps.
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ReturnType<typeof pageOf<Rankable>> = pageOf(all, "relevant", cursor === null ? null : decodeHomeCursor(cursor, "relevant"), 2);
    seen.push(...page.page.map((row) => row.coinType));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(seen, expected);
});

test("a version 3 cursor (no FDV) still reads, with its FDV unknown", () => {
  const v3 = encodeCursor("discover", [3, "relevant", "dust", 903, 0, 0, 0, 0, null, null, 8]);
  assert.deepEqual(decodeHomeCursor(v3, "relevant"), { sort: "relevant", coinType: "dust", score: 903, breadth: 0, activity: 0, recency: 0, volume: 0, latestMs: null, launchedMs: null, holders: 8, fdvUsd: null });
});

/** Every row of `rows` in `sort`'s order, walked two at a time through the keyset cursor. */
function walk(rows: Rankable[], sort: Parameters<typeof homeOrder>[0]): string[] {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ReturnType<typeof pageOf<Rankable>> = pageOf(rows, sort, cursor === null ? null : decodeHomeCursor(cursor, sort), 2);
    seen.push(...page.page.map((row) => row.coinType));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return seen;
}

test("progress, market cap and last trade: highest first, unknown last, ties by coin type; keyset paging repeats and skips nothing", () => {
  const rows = [
    rankable("c-unknown", {}),
    rankable("b-half", { progressBps: 5_000, marketCapUsd: 10 }),
    rankable("a-half", { progressBps: 5_000, marketCapUsd: 10 }),
    rankable("ready", { progressBps: 10_000, marketCapUsd: 2_000, lastTradeMs: 50 }),
    rankable("listed-big", { marketCapUsd: 900_000, lastTradeMs: 900, launchedMs: 1 }),
    rankable("listed-small", { marketCapUsd: 5_000, launchedMs: 7 }),
    rankable("quiet-old", { launchedMs: 3 }),
  ];
  // Progress: curves by percent, then every other coin by market cap.
  const progress = ["ready", "a-half", "b-half", "listed-big", "listed-small", "c-unknown", "quiet-old"];
  assert.deepEqual([...rows].sort(homeOrder("progress")).map((row) => row.coinType), progress);
  assert.deepEqual(walk(rows, "progress"), progress);
  // A coin with no market cap goes last; it is not dropped.
  const marketCap = ["listed-big", "listed-small", "ready", "a-half", "b-half", "c-unknown", "quiet-old"];
  assert.deepEqual([...rows].sort(homeOrder("market_cap")).map((row) => row.coinType), marketCap);
  assert.deepEqual(walk(rows, "market_cap"), marketCap);
  assert.equal(pageOf(rows, "market_cap", null, 2).total, rows.length);
  // Last trade: newest trade first; coins without one after, newest launch first.
  const lastTrade = ["listed-big", "ready", "listed-small", "quiet-old", "a-half", "b-half", "c-unknown"];
  assert.deepEqual([...rows].sort(homeOrder("last_trade")).map((row) => row.coinType), lastTrade);
  assert.deepEqual(walk(rows, "last_trade"), lastTrade);
});

test("Closest to graduating: curves traded in the last 24 hours lead by progress, so a dormant curve never tops a live one; paging crosses the groups", () => {
  const rows = [
    rankable("dormant-ready", { progressBps: 10_000 }),
    rankable("dormant-high", { progressBps: 9_000 }),
    rankable("live-low", { progressBps: 500, recentlyTraded: true }),
    rankable("live-top", { progressBps: 2_829, recentlyTraded: true }),
    rankable("dormant-low", { progressBps: 100 }),
  ];
  const closest = ["live-top", "live-low", "dormant-ready", "dormant-high", "dormant-low"];
  assert.deepEqual([...rows].sort(homeOrder("progress")).map((row) => row.coinType), closest);
  assert.deepEqual(walk(rows, "progress"), closest);
});

test("a cursor carries progress, market cap and last trade, and the idle bit (version 6) only where inputs do not imply it; versions 5 and 4 still read", () => {
  const position = { sort: "progress" as const, coinType: "x::x::X", score: 0, breadth: 0, activity: 0, recency: 0, volume: 0, latestMs: null, launchedMs: 4, holders: null, fdvUsd: 12.5, progressBps: 6_000, marketCapUsd: 99.5, lastTradeMs: 77 };
  // A sale opening soon: active with no participants, so the bit travels.
  assert.deepEqual(decodeHomeCursor(encodeHomeCursor({ ...position, idle: false }), "progress"), { ...position, idle: false });
  // A coin: idle as its inputs say, so the cursor stays version 5 for pods that predate the bit.
  assert.deepEqual(decodeHomeCursor(encodeHomeCursor({ ...position, idle: true }), "progress"), position);
  assert.throws(() => decodeHomeCursor(encodeCursor("discover", [5, "progress", "x", 0, 0, 0, 0, 0, null, null, null, null, 10_001, null, null]), "progress"), "progress is at most 100%");
  const v4 = encodeCursor("discover", [4, "relevant", "dust", 903, 0, 0, 0, 0, null, null, 8, 3.2]);
  // A recently traded curve (Closest to graduating's first group): version 7 carries the bit.
  assert.deepEqual(decodeHomeCursor(encodeHomeCursor({ ...position, idle: true, recentlyTraded: true }), "progress"), { ...position, idle: true, recentlyTraded: true });
  assert.throws(() => decodeHomeCursor(encodeCursor("discover", [7, "progress", "x", 0, 0, 0, 0, 0, null, null, null, null, 10, null, null, true, false]), "progress"), "version 7 is only written for a recently traded curve");
  assert.deepEqual(decodeHomeCursor(v4, "relevant"), { sort: "relevant", coinType: "dust", score: 903, breadth: 0, activity: 0, recency: 0, volume: 0, latestMs: null, launchedMs: null, holders: 8, fdvUsd: 3.2 });
});

test("stages: almost needs a known progress, however low; graduated needs a DEX listing", () => {
  const candidate = { participants: 0, launchedMs: null, tradable: false, knownDeployer: false, listed: false, progressBps: null as number | null, nowMs: 0 };
  const almost = { ...HOME_DEFAULT_QUERY, stage: "almost" as const };
  const graduated = { ...HOME_DEFAULT_QUERY, stage: "graduated" as const };
  assert.equal(passesFilters(almost, { ...candidate, progressBps: 2_829 }), true, "no fixed line: a curve at 28% lists");
  assert.equal(passesFilters(almost, { ...candidate, progressBps: 0 }), true);
  assert.equal(passesFilters(almost, candidate), false, "a curve with an unknown target is not on Closest to graduating");
  assert.equal(passesFilters(almost, { ...candidate, listed: true }), false);
  assert.equal(passesFilters(graduated, { ...candidate, listed: true }), true);
  assert.equal(passesFilters(graduated, { ...candidate, progressBps: 9_000 }), false, "a curve still filling is not graduated");
  assert.equal(passesFilters(HOME_DEFAULT_QUERY, candidate), true);
});

test("curve progress is a percent of each curve's own target, so SUI and USDC curves order together", () => {
  const facts = (lifecycle: string, reserve: string | null, target: string | null) => ({ curve_lifecycle: lifecycle, quote_reserve: reserve, graduation_target: target });
  // 500 of 1,000 SUI (9 decimals) has far more atoms than 700 of 1,000 USDC (6 decimals), yet less progress.
  const sui = curveOf(facts("live", "500000000000", "1000000000000"));
  const usdc = curveOf(facts("live", "700000000", "1000000000"));
  assert.deepEqual(sui, { lifecycle: "live", progress_bps: 5_000, quote_remaining: "500000000000" });
  assert.deepEqual(usdc, { lifecycle: "live", progress_bps: 7_000, quote_remaining: "300000000" });
  const rows = [rankable("sui", { progressBps: sui!.progress_bps }), rankable("usdc", { progressBps: usdc!.progress_bps })];
  assert.deepEqual(rows.sort(homeOrder("progress")).map((row) => row.coinType), ["usdc", "sui"]);
  // A full curve waiting to migrate, and one that has, are at 100% with nothing to go.
  assert.deepEqual(curveOf(facts("migration_ready", "1", "2")), { lifecycle: "migration_ready", progress_bps: 10_000, quote_remaining: "0" });
  assert.deepEqual(curveOf(facts("migrated", null, null)), { lifecycle: "migrated", progress_bps: 10_000, quote_remaining: "0" });
  // An unknown or zero target is unknown progress, never a guess.
  assert.deepEqual(curveOf(facts("live", "1", null)), { lifecycle: "live", progress_bps: null, quote_remaining: null });
  assert.deepEqual(curveOf(facts("live", "1", "0")), { lifecycle: "live", progress_bps: null, quote_remaining: null });
  assert.equal(curveOf(facts("unknown", "1", "2")), null);
  assert.equal(curveOf({ curve_lifecycle: null, quote_reserve: null, graduation_target: null }), null);
});

test("New has its own capped base and key; its age narrows that base", () => {
  const context = { nowMs: 0, hiddenKinds: [], terms: null };
  const key = (stage: "all" | "new" | "almost" | "graduated") => homeDiscoverBaseKey("24h", stage, context);
  assert.notEqual(key("new"), key("all"));
  assert.notEqual(key("new"), key("almost"));
  assert.equal(key("graduated"), key("all"), "Graduated filters the whole list");
  assert.match(homeNewCoinSources("$3::bigint"), new RegExp(`ORDER BY n\\.launched_ms DESC,n\\.source_id\\s+LIMIT ${HOME_NEW_LIMIT}\\)$`));
  const now = 10 * 86_400_000;
  const candidate = { participants: 0, launchedMs: now - 2 * 3_600_000, tradable: false, knownDeployer: false, listed: false, progressBps: 100, nowMs: now };
  const fresh = { ...HOME_DEFAULT_QUERY, stage: "new" as const };
  assert.equal(passesFilters({ ...fresh, age: "24h" }, candidate), true, "a curve still filling is new");
  assert.equal(passesFilters({ ...fresh, age: "1h" }, candidate), false);
  assert.equal(passesFilters({ ...fresh, age: "1h" }, { ...candidate, launchedMs: now - 60_000 }), true);
});
