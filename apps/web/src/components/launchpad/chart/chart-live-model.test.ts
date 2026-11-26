import assert from "node:assert/strict";
import test from "node:test";

import { parsePoolCandlePage, type Candle, type PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { applyChartFrame, candlesFromTrades, ChartBackfillRequired, liveTrace, parseChartFrame } from "./chart-live-model.ts";
import { chartRequest, parseChartControls, parseLiveChartControls } from "./chart-model.ts";

const POOL = `blast_curve:0x${"11".repeat(32)}`;
const DEPLOYMENT = "ab".repeat(32);
const NOW = 1_790_000_000_000;
const expected = { network: "mainnet" as const, deployment: DEPLOYMENT };
const request = chartRequest({ interval: "1s", range: "all" }, NOW);
const candle = (bucketStart: number, close = "1"): Candle => ({ bucketStart, open: close, high: close, low: close, close, volumeQuote: 7n, volumeMeme: 9n, volumeUsd: null, buys: 1, sells: 0, trades: 1 });
const page = (candles: Candle[] = [candle(NOW)]): PoolCandlePage => ({ poolKey: POOL, source: "curve", venue: "blast_curve", interval: "1s", candles, migration: null });

function wire(checkpoint = 11, at = NOW + 100, price = "2", part = 2) {
  return {
    type: "trade", cursor: `${checkpoint}:1:0:${part}`, checkpoint, timestamp_ms: at,
    provenance: { network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: at, observed_ms: at + 20, lag_ms: 20 },
    trade: { cursor: `${checkpoint}:1:0:0`, timestamp_ms: at, digest: "1".repeat(32), pool_key: POOL, venue: "blast_curve", trader: null, side: "buy", kind: "buy", quote_amount: "18446744073709551615", meme_amount: "3", price, volume_usd: "0.000000000000000001", venue_swap: null },
  };
}

test("1s candles belong to Live; a 1s link on a history range takes that range's interval", () => {
  assert.equal(parseChartControls({ interval: "1s" }).interval, "5m");
  // 3,600 one-second candles do not fit one 2,000-candle page: the hour would be half drawn.
  assert.deepEqual(parseLiveChartControls({ interval: "1s", range: "1h" }), { interval: "1m", range: "1h" });
  assert.deepEqual(chartRequest({ interval: "1s", range: "1h" }, NOW), { interval: "1s", from: NOW - 3_600_000, limit: 2000, capped: true });
});

test("Live links select one-second candles and share one cache key across opening times", () => {
  const live = parseLiveChartControls({ range: "live", interval: "1h" });
  assert.deepEqual(live, { range: "live", interval: "1s" });
  assert.deepEqual(chartRequest(live, NOW), { interval: "1s", limit: 301, capped: false });
  assert.deepEqual(chartRequest(live, NOW + 3_000), chartRequest(live, NOW));
  assert.equal(parseChartControls({ range: "live", interval: "1s" }).range, "all");
});

test("1s updates keep exact prices, u64 volumes, nullable USD sums and separate outer/inner cursors", () => {
  const frame = parseChartFrame(wire(), POOL, expected, null);
  assert.equal(frame.cursor, "11:1:0:2");
  assert.equal(frame.type === "trade" && frame.trade.cursor, "11:1:0:0");
  const first = applyChartFrame(page(), frame, request);
  assert.deepEqual(first.candles[0], { bucketStart: NOW, open: "1", high: "2", low: "1", close: "2", volumeQuote: 18446744073709551622n, volumeMeme: 12n, volumeUsd: "0.000000000000000001", buys: 2, sells: 0, trades: 2 });
  const raw = wire(12, NOW + 200, "0.000000000000000000000000000000000001");
  raw.trade.side = "sell";
  const next = applyChartFrame(first, parseChartFrame(raw, POOL, expected, null), request);
  assert.equal(next.candles[0].volumeUsd, "0.000000000000000002");
  assert.equal(next.candles[0].low, raw.trade.price);
  assert.equal(next.candles[0].sells, 1);
  assert.equal(page().candles[0].volumeQuote, 7n, "the durable baseline is immutable");
});

test("a new second opens at the previous close across gaps and never fills empty seconds", () => {
  const next = applyChartFrame(page(), parseChartFrame(wire(11, NOW + 3_100, "2"), POOL, expected, null), request);
  assert.deepEqual(next.candles.map((item) => [item.bucketStart, item.open, item.high, item.low]), [[NOW, "1", "1", "1"], [NOW + 3000, "1", "2", "1"]]);
  assert.equal(next.candles.length, 2);
  assert.throws(() => applyChartFrame(page([]), parseChartFrame(wire(), POOL, expected, null), { ...request, from: NOW }), ChartBackfillRequired);
  assert.equal(applyChartFrame(page([]), parseChartFrame(wire(), POOL, expected, null), request).candles[0].open, "2");
});

test("fills and unpriced trades add no candles or volumes; pages stay bounded", () => {
  const raw = wire();
  raw.trade.kind = "opening_round_fill";
  assert.deepEqual(applyChartFrame(page(), parseChartFrame(raw, POOL, expected, null), request), page());
  const original = page([candle(NOW - 1000), candle(NOW)]);
  const next = applyChartFrame(original, parseChartFrame(wire(11, NOW + 1000), POOL, expected, null), { ...request, limit: 2 });
  assert.deepEqual(next.candles.map((item) => item.bucketStart), [NOW, NOW + 1000]);
});

test("derived intervals use engine UTC/Monday buckets and never use the attached open 1m candle", () => {
  const monday = Date.UTC(2026, 9, 26);
  const raw = { ...wire(11, monday + 1000), candle: { bucket_start: 999 } };
  const week: PoolCandlePage = { ...page([candle(monday - 7 * 86_400_000)]), interval: "1w" };
  const next = applyChartFrame(week, parseChartFrame(raw, POOL, expected, null), chartRequest({ interval: "1w", range: "all" }, monday));
  assert.equal(next.candles.at(-1)?.bucketStart, monday);
  assert.equal(next.candles.at(-1)?.open, "1");
});

test("candle_closed replaces the engine interval authoritatively without adding volumes twice", () => {
  const at = Math.floor(NOW / 60_000) * 60_000;
  const raw = wire(12, at + 60_000);
  const closed = { type: "candle_closed", cursor: raw.cursor, checkpoint: raw.checkpoint, timestamp_ms: raw.timestamp_ms, provenance: raw.provenance, pool_key: POOL, interval: "1m", candle: { bucket_start: at, interval: "1m", open: "1", high: "3", low: "1", close: "3", volume_quote: "100", volume_meme: "200", volume_usd: null, buys: 2, sells: 0, trades: 2 } };
  const minute: PoolCandlePage = { ...page([candle(at)]), interval: "1m" };
  const frame = parseChartFrame(closed, POOL, expected, null);
  const next = applyChartFrame(minute, frame, chartRequest({ interval: "1m", range: "all" }, NOW));
  assert.equal(next.candles[0].volumeQuote, 100n);
  assert.equal(next.candles[0].close, "3");
  assert.deepEqual(applyChartFrame(next, frame, chartRequest({ interval: "1m", range: "all" }, NOW)), next);
  assert.deepEqual(applyChartFrame(page(), frame, request), page(), "a minute close is not a one-second candle");
  assert.throws(() => parseChartFrame({ ...closed, interval: "1s" }, POOL, expected, null));
});

test("foreign deployments, pools, malformed envelopes and migration crossing cannot alter candles", () => {
  const raw = wire();
  assert.throws(() => parseChartFrame(raw, POOL, { ...expected, deployment: "cd".repeat(32) }, null));
  assert.throws(() => parseChartFrame({ ...raw, cursor: "12:0:0:0" }, POOL, expected, null));
  assert.throws(() => parseChartFrame({ ...raw, trade: { ...raw.trade, pool_key: `blast_curve:0x${"22".repeat(32)}` } }, POOL, expected, null));
  const migrated = { ...page(), migration: { cursor: "11:0:0:0", timestampMs: NOW, curvePoolKey: POOL, venuePoolKey: null } };
  assert.throws(() => applyChartFrame(migrated, parseChartFrame(raw, POOL, expected, migrated.migration), request), ChartBackfillRequired);
  const body = { interval: "1s", candles: [], migration: null };
  assert.deepEqual(parsePoolCandlePage(POOL, "1s", body).candles, []);
});

const ROUND = { duration_ms: "3600000", starts_at_ms: String(NOW), ends_at_ms: String(NOW + 3_600_000), total_committed_quote: "18446744073709551615", bidder_count: 4, settlement: null, delivered_count: 0, undelivered_count: 4, state: "open" };
function roundWire(checkpoint = 11, round: Record<string, unknown> = ROUND, poolKey = POOL) {
  const at = NOW + 100;
  return { type: "opening_round", cursor: `${checkpoint}:3:0:0`, checkpoint, timestamp_ms: at, pool_key: poolKey, opening_round: round, provenance: { network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: at, observed_ms: at + 20, lag_ms: 20 } };
}

test("an opening round frame parses its round and never touches candles or requires backfill", () => {
  const frame = parseChartFrame(roundWire(), POOL, expected, null);
  assert.equal(frame.type, "opening_round");
  assert.equal(frame.type === "opening_round" && frame.openingRound.bidderCount, 4);
  assert.equal(frame.type === "opening_round" && frame.openingRound.totalCommittedQuote, 18446744073709551615n);
  const before = page();
  assert.equal(applyChartFrame(before, frame, request), before);
  assert.throws(() => parseChartFrame(roundWire(11, { ...ROUND, undelivered_count: 3 }), POOL, expected, null));
  assert.throws(() => parseChartFrame(roundWire(11, ROUND, `blast_curve:0x${"22".repeat(32)}`), POOL, expected, null));
  assert.throws(() => parseChartFrame({ ...roundWire(), cursor: "12:3:0:0" }, POOL, expected, null));
});

test("the Live tape applies an execution once and agrees with a clean tape fetch", () => {
  const earlier = parseChartFrame(wire(11, NOW - 101, "1"), POOL, expected, null);
  const next = parseChartFrame(wire(12, NOW + 375, "2"), POOL, expected, null);
  assert.ok(earlier.type === "trade" && next.type === "trade");
  const liveRequest = chartRequest({ interval: "1s", range: "live" }, NOW);
  const liveTrades = [earlier.trade];
  const before = { ...page(candlesFromTrades(liveTrades)), liveTrades };
  const after = applyChartFrame(before, next, liveRequest);
  assert.equal(applyChartFrame(after, next, liveRequest), after);
  assert.deepEqual(after.liveTrades, [earlier.trade, next.trade]);
  assert.deepEqual(after.candles, candlesFromTrades([earlier.trade, next.trade]));
});

test("the Live trace holds confirmed prices to the coverage edge and breaks at an unpriced execution", () => {
  const at = (frame: ReturnType<typeof parseChartFrame>) => { assert.ok(frame.type === "trade"); return frame.trade; };
  const before = at(parseChartFrame(wire(10, NOW - 10_000, "1"), POOL, expected, null));
  const traded = at(parseChartFrame(wire(11, NOW + 1_000, "2"), POOL, expected, null));
  const unpriced = { ...at(parseChartFrame(wire(12, NOW + 2_000, "3"), POOL, expected, null)), price: null };
  assert.deepEqual(liveTrace([before, traded], NOW, NOW + 5_000), [
    { timestampMs: NOW, price: "1" }, { timestampMs: NOW + 1_000, price: "2" }, { timestampMs: NOW + 5_000, price: "2" },
  ]);
  assert.deepEqual(liveTrace([before, traded, unpriced], NOW, NOW + 5_000).slice(-2), [
    { timestampMs: NOW + 1_999.5, price: "2" }, { timestampMs: NOW + 2_000, price: null },
  ], "nothing is drawn after a price the tape cannot confirm");
  assert.deepEqual(liveTrace([{ ...before, price: null }], NOW, NOW + 5_000), [], "no confirmed price, no trace");
  assert.deepEqual(liveTrace([before], NOW, NOW - 1), [], "coverage that ends before the window draws nothing");
});
