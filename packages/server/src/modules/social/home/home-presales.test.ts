import assert from "node:assert/strict";
import test from "node:test";

import { isBlastDust, raiseUsdOf } from "@blast/server/modules/social/home/coins.ts";
import { encodeCursor } from "@blast/server/modules/social/home/codec.ts";
import {
  decodeHomeCursor,
  homeOrder,
  pageOf,
  SALE_RAMP_MS,
  saleIsIdle,
  saleSlots,
  scoreOfSlots,
  upcomingSaleWhy,
  type Rankable,
  type SaleTraction,
} from "@blast/server/modules/social/home/rank.ts";

// Trending with `presales=1`: a presale not trading yet ranks on the same 0–100 score as a coin.
const HOUR = 3_600_000;
const NOW = 1_000 * 24 * HOUR;
const sale = (over: Partial<SaleTraction>): SaleTraction => ({
  startMs: null, committers: 0, committedUsd: 0, latestCommitMs: null, allCommitters: 0, savers: 0, saversGained: 0, ...over,
});
const score = (traction: SaleTraction, toMs = NOW, window: "1h" | "24h" = "24h") => scoreOfSlots(saleSlots(traction, window, toMs));

test("an upcoming sale climbs over the day before it opens, only with a saver; a far-out or unscheduled one scores savers gained only", () => {
  const saved = sale({ savers: 40, saversGained: 3 });
  const soon = score({ ...saved, startMs: NOW + 3 * HOUR });
  const later = score({ ...saved, startMs: NOW + 12 * HOUR });
  assert.ok(soon > later && later > 0, "closer to the opening scores higher");
  // No saver: no ramp, nothing gained, idle whatever its schedule.
  const unsaved = saleSlots(sale({ startMs: NOW + HOUR }), "24h", NOW);
  assert.deepEqual([scoreOfSlots(unsaved), saleIsIdle(unsaved)], [0, true]);
  // Opens in three days, or has no schedule: only the savers it gained in the window count, in people and new holders.
  for (const startMs of [NOW + 72 * HOUR, null]) {
    const slots = saleSlots({ ...saved, startMs }, "24h", NOW);
    assert.deepEqual([slots.netInflow, slots.volume, slots.freshness, slots.holders], [0, 0, 0, 0]);
    assert.ok(slots.breadth > 0 && slots.newHolders > 0);
    assert.equal(saleIsIdle(saleSlots({ ...saved, saversGained: 0, startMs }, "24h", NOW)), true, "old savers alone do not lift a far-out sale");
  }
  // The stock of savers sits on the 24h caps in either window, so an hour's view never fills up on old saves.
  assert.ok(score({ ...saved, startMs: NOW + HOUR }, NOW, "1h") <= 10_000);
  assert.ok(score({ ...saved, savers: 1e9, saversGained: 1e9, startMs: NOW + 1 }, NOW, "24h") <= 10_000, "never above 100");
  assert.equal(upcomingSaleWhy(1_234, NOW + 3 * HOUR + 5, NOW), "1,234 saved · opens in 3h");
  assert.equal(upcomingSaleWhy(2, NOW + 49 * HOUR, NOW), "2 saved · opens in 2d");
  assert.equal(upcomingSaleWhy(0, null, NOW), "0 saved · not scheduled");
});

test("no cliff at the opening: savers fade over its first day, the opening itself is fresh, and commits take over", () => {
  const start = NOW;
  const saved = sale({ savers: 40, startMs: start });
  const before = score(saved, start - 60_000);
  const opening = score(saved, start);
  const after = score(saved, start + 60_000);
  assert.ok(opening >= before, `the opening (${opening}) is not below just before (${before})`);
  assert.ok(opening - after <= 10, `a minute later (${after}) has faded at most 0.1 of a point from the opening (${opening})`);
  assert.equal(saleSlots(saved, "24h", start).freshness, 1, "the opening keeps freshness at 1");
  // Opening day with nobody committing yet: old savers still score, fading.
  const sixHours = score(saved, start + 6 * HOUR);
  assert.ok(sixHours > 0 && sixHours < after);
  assert.equal(saleIsIdle(saleSlots(saved, "24h", start + 6 * HOUR)), false);
  // After a day the savers are gone: a sale with no commits in the window is idle.
  assert.equal(saleIsIdle(saleSlots(saved, "24h", start + SALE_RAMP_MS + 60_000)), true);
  // Commits count like trades: more people and dollars, a higher score, never below the fading savers.
  // A sale nobody saved or backed is idle from its opening, not fresh.
  assert.equal(saleIsIdle(saleSlots(sale({ startMs: start }), "24h", start + 10 * 60_000)), true);
  const busy = score({ ...saved, committers: 30, committedUsd: 9_000, latestCommitMs: start + 6 * HOUR - 1, allCommitters: 30 }, start + 6 * HOUR);
  assert.ok(busy > sixHours);
});

test("an ended or funded sale scores its window commits and all-time committers only", () => {
  const ended = sale({ startMs: NOW - 5 * 24 * HOUR, allCommitters: 80 });
  // No commit in the window: idle (holders alone never lift it), whatever claims happened (claims never reach `SaleTraction`).
  assert.equal(saleIsIdle(saleSlots(ended, "24h", NOW)), true);
  const late = saleSlots({ ...ended, committers: 2, committedUsd: 300, latestCommitMs: NOW - HOUR }, "24h", NOW);
  assert.equal(saleIsIdle(late), false);
  assert.ok(late.holders > 0 && late.freshness > 0);
});

const idle = { breadth: 0, activity: 0, recency: 0, volume: 0 };
const rankable = (coinType: string, over: Partial<Rankable>): Rankable => ({ coinType, score: 0, inputs: idle, latestMs: null, launchedMs: null, ...over });

test("a sale that opens soon is active with no window activity; paging across it keeps the idle bit", () => {
  const coin = rankable("coin", { score: 4_000, inputs: { breadth: 5, activity: 9, recency: 2, volume: 800 }, latestMs: NOW - HOUR });
  const opensSoon = rankable("sale-soon", { score: 3_000, idle: false });
  const raisedSale = rankable("sale-raised", { idle: true, fdvUsd: 50_000 });
  const upcomingIdle = rankable("sale-idle", { idle: true, fdvUsd: null });
  const idleCoin = rankable("idle-coin", { score: 900, fdvUsd: 20_000, holders: 8 });
  const all = [upcomingIdle, idleCoin, raisedSale, opensSoon, coin];
  // Active first by score, then idle by market value: raised USD stands in for FDV, an upcoming sale has none and goes last.
  assert.deepEqual([...all].sort(homeOrder("relevant")).map((row) => row.coinType), ["coin", "sale-soon", "sale-raised", "idle-coin", "sale-idle"]);
  const first = pageOf(all, "relevant", null, 2);
  assert.deepEqual(first.page.map((row) => row.coinType), ["coin", "sale-soon"]);
  const second = pageOf(all, "relevant", decodeHomeCursor(first.nextCursor!, "relevant"), 2);
  assert.deepEqual(second.page.map((row) => row.coinType), ["sale-raised", "idle-coin"], "the cursor remembers the sale was active");
  const third = pageOf(all, "relevant", decodeHomeCursor(second.nextCursor!, "relevant"), 2);
  assert.deepEqual([third.page.map((row) => row.coinType), third.nextCursor], [["sale-idle"], null]);
  // A cursor from before the idle bit (v5) still pages: idleness follows from its inputs.
  const v5 = encodeCursor("discover", [5, "relevant", "coin", 4_000, 5, 9, 2, 800, NOW - HOUR, null, null, null, null, null, null]);
  assert.deepEqual(pageOf(all, "relevant", decodeHomeCursor(v5, "relevant"), 1).page.map((row) => row.coinType), ["sale-soon"]);
});

test("dust: a sale not trading yet reads its target (a target of 0 is no target); a trading sale reads what it raised", () => {
  const facts = { tracked_pool_only: false, presale_id: "0xsale", quote_decimals: 9, quote_price_usd: "2", raised: "0", graduation_target: null };
  // 400 SUI target at $2: $800, dust before it opens, though it has raised nothing yet either way.
  assert.equal(raiseUsdOf({ ...facts, lifecycle: "open", raise_target: "400000000000" }), 800);
  assert.equal(isBlastDust({ ...facts, lifecycle: "pending", raise_target: "400000000000" }, null), true);
  assert.equal(isBlastDust({ ...facts, lifecycle: "open", raise_target: "5000000000000" }, null), false, "a $10,000 target is kept before a coin is committed");
  assert.equal(isBlastDust({ ...facts, lifecycle: "funded", raise_target: "0" }, null), false, "no target is unknown, not small");
  // Trading: what it raised, as before.
  assert.equal(raiseUsdOf({ ...facts, lifecycle: "migrated", raise_target: "5000000000000", raised: "100000000000" }), 200);
});
