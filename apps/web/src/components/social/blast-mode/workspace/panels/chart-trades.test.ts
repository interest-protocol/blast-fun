import assert from "node:assert/strict";
import test from "node:test";
import { proofThread, proofTraders } from "../../../../../../test/fixtures/workspace/redesign-fixtures";
import { publicPnlRanks } from "../holder-signals";
import { annotationId, chartTradeY, DEFAULT_TRADE_FILTERS, filterChartTrades, groupChartTrades, withChartPosts } from "./chart-trades";
import { chartVisual } from "./chart-visual";
import { chartPostsFixture, chartTradesFixture } from "../../../../../../test/fixtures/workspace/chart-trades-fixture";

test("trade filters union explicit KOL, public PnL and confirmed following without duplicate events", () => {
  const page = proofThread("LUMN");
  const trades = filterChartTrades([...page.participants, ...page.participants], DEFAULT_TRADE_FILTERS, new Set(["maralin"]), publicPnlRanks(proofTraders.traders), callsign => callsign === "maralin");
  assert.equal(trades.length, 4);
  const mara = trades.find(row => row.actor.type === "account" && row.actor.callsign === "maralin")!;
  assert.deepEqual(mara.groups, ["kol", "top", "following"]);
  assert.equal(mara.event.kind, "trade_sell");
  assert.equal(new Set(trades.map(row => row.event.activity_id)).size, trades.length);
  assert.deepEqual(filterChartTrades(page.participants, DEFAULT_TRADE_FILTERS, new Set(), new Map(), () => undefined), [], "verification and unknown relationships never classify a trader");
});

test("authored posts enrich the same public trade once; calls stay posts and other markets/authors are excluded", () => {
  const posts = chartPostsFixture("coin", "market");
  const ranks = publicPnlRanks(proofTraders.traders);
  const trades = filterChartTrades(chartTradesFixture("coin").participants, DEFAULT_TRADE_FILTERS, new Set(["maralin"]), ranks, () => true);
  const selected = withChartPosts(trades, posts.items, "market", DEFAULT_TRADE_FILTERS, new Set(["maralin"]), ranks, () => true);
  assert.equal(selected.length, trades.length + 2);
  assert.equal(new Set(selected.map(annotationId)).size, selected.length);
  const linked = selected.find(row => annotationId(row) === posts.items[0]!.entry_id)!;
  assert.ok("event" in linked && linked.thesis?.why?.text === posts.items[0]!.why!.text);
  assert.equal(selected.filter(row => "post" in row && row.post.call).length, 1);
  assert.deepEqual(withChartPosts(trades, posts.items, "other-market", DEFAULT_TRADE_FILTERS, new Set(), ranks, () => true), [...trades].sort((a,b)=>a.event.occurred_at_ms-b.event.occurred_at_ms));
  assert.equal(withChartPosts(trades, posts.items, "market", { ...DEFAULT_TRADE_FILTERS, posts: false }, new Set(), ranks, () => true), trades);
  const forged = { ...posts.items[0]!, actor: posts.items[2]!.actor };
  assert.ok(!withChartPosts(trades, [forged], "market", DEFAULT_TRADE_FILTERS, new Set(), ranks, () => true).some(row => "event" in row && row.thesis));
  const postsOnly = withChartPosts([], posts.items, "market", { ...DEFAULT_TRADE_FILTERS, buy: false, sell: false }, new Set(), ranks, () => true);
  assert.equal(postsOnly.length, 2, "disabling both sides cannot fabricate trade directions for calls/theses");
});

test("side and empty filters remain literal; claims and commitments never become buys", () => {
  const page = proofThread("LUMN");
  const options = { ...DEFAULT_TRADE_FILTERS, groups: { kol: true, top: false, following: false }, buy: false };
  const trades = filterChartTrades(page.participants, options, new Set(["maralin"]), new Map(), () => true);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]!.event.kind, "trade_sell");
  assert.deepEqual(filterChartTrades(page.participants, { ...options, sell: false }, new Set(["maralin"]), new Map(), () => true), []);
  assert.deepEqual(filterChartTrades(page.participants, { ...options, groups: { kol: false, top: false, following: false } }, new Set(["maralin"]), new Map(), () => true), []);
  const row = page.participants[0]!;
  assert.deepEqual(filterChartTrades([{ ...row, events: row.events!.map(event => ({ ...event, kind: "presale_commit" })) }], DEFAULT_TRADE_FILTERS, new Set(), new Map(), () => true), []);
});

test("time grouping excludes off-range events and preserves every same-time event and exact amount", () => {
  const selected = filterChartTrades(proofThread("LUMN").participants, DEFAULT_TRADE_FILTERS, new Set(), publicPnlRanks(proofTraders.traders), () => false);
  const trades = selected.map((row, index) => ({ ...row, event: { ...row.event, occurred_at_ms: [0, 100, 100, 201][index]! } }));
  const groups = groupChartTrades(trades, 0, 200, 88);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(row => row.trades.length), [1, 2]);
  assert.deepEqual(groups.flatMap(row => row.trades.map(trade => trade.event.quote)), trades.slice(0, 3).map(trade => trade.event.quote));
  assert.deepEqual(groupChartTrades(trades, 200, 0, 88), []);
  assert.equal(groupChartTrades(trades, 100, 100, 44)[0]!.trades.length, 2);
  assert.equal(groupChartTrades(trades, 0, 201, 0).length, 1);
});

test("trade overlay follows rendered segments and never invents prices in gaps or source changes", () => {
  const visual = chartVisual([
    { at: 0, value: "1", source: "curve" },
    { at: 60_000, value: "2", source: "curve" },
    { at: 180_000, value: "3", source: "curve" },
    { at: 240_000, value: "4", source: "venue" },
  ], 60_000)!;
  const [first, second] = visual.points;
  assert.equal(chartTradeY(visual.segments, 0), first!.y / 3);
  assert.equal(chartTradeY(visual.segments, 12.5), (first!.y + second!.y) / 6);
  assert.equal(chartTradeY(visual.segments, 50), null, "missing observations have time-only markers");
  assert.equal(chartTradeY(visual.segments, 87.5), null, "never bridge curve to venue");
  assert.equal(chartTradeY(visual.segments, 100), visual.points.at(-1)!.y / 3);
  assert.equal(chartTradeY([], 50), null);
});

test("canvas coordinates regroup activity after zoom and exclude offscreen events", () => {
  const trades = filterChartTrades(proofThread("LUMN").participants, DEFAULT_TRADE_FILTERS, new Set(), publicPnlRanks(proofTraders.traders), () => true);
  const chosen = trades.slice(0, 3).map((trade, index) => ({ ...trade, event: { ...trade.event, occurred_at_ms: [10, 20, 30][index]! } }));
  const positions = new Map([[10, -.2], [20, .2], [30, .8]]);
  const groups = groupChartTrades(chosen, 0, 100, 128, 64, at => positions.get(at) ?? null);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.left), [25, 75]);
  assert.deepEqual(groups.flatMap(group => group.trades.map(trade => trade.event.occurred_at_ms)), [20, 30]);
});
