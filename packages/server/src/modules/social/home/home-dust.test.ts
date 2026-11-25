import assert from "node:assert/strict";
import test from "node:test";

import { isBlastDust, raiseUsdOf } from "@blast/server/modules/social/home/coins.ts";
import { createCurveTargetReader, CURVE_TARGET_REFRESH_MS } from "@blast/server/modules/social/home/curve-targets.ts";
import { encodeCursor } from "@blast/server/modules/social/home/codec.ts";
import { decodeHomeCursor, HOME_DUST_USD, homeOrder, pageOf, type Rankable } from "@blast/server/modules/social/home/rank.ts";

const base = { tracked_pool_only: false, quote_decimals: 9, quote_price_usd: "2" as string | null, raised: "0" };
const sale = (raised: string, quotePrice: string | null = "2") => ({ ...base, presale_id: "0xsale", raised, quote_price_usd: quotePrice });
const curve = { ...base, presale_id: null };
const catalog = { ...curve, tracked_pool_only: true };
const dust = (facts: Parameters<typeof isBlastDust>[0], marketCapUsd: number | null, graduationTarget: string | null = null) => isBlastDust(facts, { marketCapUsd, graduationTarget });

test("dust: a raise (a sale's, or a curve's graduation target) or a market cap under $1,000; never catalog coins or unknown values", () => {
  // TETEMU: 0.55 SUI at $2 raised $1.10.
  assert.equal(raiseUsdOf(sale("550000000"), null), 1.1);
  assert.equal(dust(sale("550000000"), 1_000_000), true, "a big market cap does not rescue a sale that raised dust");
  // 500 SUI at $2 is exactly the threshold: kept.
  assert.equal(dust(sale("500000000000"), null), false);
  assert.equal(dust(sale("499999999999"), null), true);
  assert.equal(dust(sale("500000000000"), HOME_DUST_USD - 0.01), true, "a sale that raised enough but now trades under $1,000");
  assert.equal(dust(sale("1", null), null), false, "an unpriced quote is unknown, not small");
  // A curve that had to raise 400 SUI ($800) to graduate.
  assert.equal(raiseUsdOf(curve, "400000000000"), 800);
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

test("curve targets: read once, kept, re-read only for an unseen launch, at most once a minute", async () => {
  const launch = (launchId: string, target: bigint | null) => ({ launchId, economics: { inputs: { graduationTarget: target } } });
  let pages: { launches: ReturnType<typeof launch>[]; nextCursor: string | null }[] = [
    { launches: [launch("b", 8_000n), launch("a", 400n)], nextCursor: "c1" },
    { launches: [launch("z", null)], nextCursor: null },
  ];
  const asked: (string | null)[] = [];
  let nowMs = 0;
  const read = createCurveTargetReader(async (cursor) => {
    asked.push(cursor);
    const page = pages[cursor === null ? 0 : 1]!;
    return { status: "fresh", provenance: {} as never, data: { kind: "answer", value: { view: "graduated", ...page } as never } };
  }, () => nowMs);
  assert.deepEqual([...(await read(["a"]))], [["b", "8000"], ["a", "400"]]);
  assert.deepEqual(asked, [null, "c1"]);
  await read(["a", "b"]);
  assert.equal(asked.length, 2, "known targets need no read");
  await read(["new"]);
  assert.equal(asked.length, 2, "an unseen launch waits for the refresh interval");
  nowMs = CURVE_TARGET_REFRESH_MS;
  pages = [{ launches: [launch("new", 9_000n), launch("b", 8_000n)], nextCursor: "c1" }, pages[1]!];
  assert.equal((await read(["new"])).get("new"), "9000");
  assert.deepEqual(asked, [null, "c1", null], "a page with a launch it knew ends the walk");
});

test("curve targets: a walk that fails keeps nothing, and a slow walk never holds a read", async () => {
  const answer = (launches: { launchId: string; target: bigint }[], nextCursor: string | null) => ({
    status: "fresh", provenance: {} as never,
    data: { kind: "answer", value: { view: "graduated", nextCursor, launches: launches.map(({ launchId, target }) => ({ launchId, economics: { inputs: { graduationTarget: target } } })) } as never },
  }) as const;
  let nowMs = 0;
  let failSecond = true;
  const read = createCurveTargetReader(async (cursor) => {
    if (cursor === null) return answer([{ launchId: "b", target: 8_000n }], "c1");
    if (failSecond) return { status: "unavailable" } as never;
    return answer([{ launchId: "a", target: 400n }], null);
  }, () => nowMs);
  assert.equal((await read(["a"])).size, 0, "page 2 failed: page 1's targets are not kept, so no gap hides behind them");
  nowMs = CURVE_TARGET_REFRESH_MS;
  failSecond = false;
  assert.deepEqual([...(await read(["a"]))], [["b", "8000"], ["a", "400"]]);

  let release = () => {};
  const slow = createCurveTargetReader(() => new Promise((resolve) => { release = () => resolve(answer([{ launchId: "s", target: 1n }], null)); }), () => 0, 5);
  assert.equal((await slow(["s"])).size, 0, "the read returns after the wait, unknown");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await slow(["s"])).get("s"), "1", "the walk finished on its own");
});
