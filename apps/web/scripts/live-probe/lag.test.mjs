import assert from "node:assert/strict";
import { test } from "node:test";
import { frameLag, parseSseBlock, percentile, summarize } from "./lag.mjs";

test("parseSseBlock joins data lines and skips comments", () => {
  assert.deepEqual(parseSseBlock("id: 1:0:0:0\nevent: market\n: comment\ndata: {\"a\":\ndata: 1}"), { event: "market", data: "{\"a\":\n1}", id: "1:0:0:0" });
  assert.deepEqual(parseSseBlock("event: heartbeat\ndata: {}"), { event: "heartbeat", data: "{}", id: null });
  assert.equal(parseSseBlock(": comment"), null);
});

test("frameLag measures receipt minus chain time, with hop offsets", () => {
  const data = JSON.stringify({ type: "trade", timestamp_ms: 1_000, cursor: "5:0:0:0", provenance: { timestamp_ms: 1_000, lag_ms: 7, hops: { r2_put_ms: 38, picked_ms: 1_150, relay_ms: 1_160 } } });
  assert.deepEqual(frameLag({ event: "market", data }, 1_400), {
    kind: "market:trade", lag_ms: 400, chain_ms: 1_000, received_ms: 1_400, cursor: "5:0:0:0", hops: { r2_put_ms: 38, picked_ms: 150, relay_ms: 160 },
  });
  const prices = JSON.stringify({ checkpoint: 5, prices: [{ as_of_ms: 900 }, { as_of_ms: 950 }] });
  assert.equal(frameLag({ event: "prices", data: prices }, 1_000).lag_ms, 50);
  assert.equal(frameLag({ event: "heartbeat", data: "{}" }, 1_000), null);
  assert.equal(frameLag({ event: "market", data: "not json" }, 1_000), null);
});

test("percentile uses nearest rank and summarize groups by kind", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile([3], 99), 3);
  assert.equal(percentile([], 50), null);
  const summary = summarize([{ kind: "market:trade", lag_ms: 10 }, { kind: "market:trade", lag_ms: 30 }, { kind: "market:candle_closed", lag_ms: 20 }, { kind: "prices", lag_ms: 5000 }]);
  assert.deepEqual(summary.market, { n: 3, p50: 20, p95: 30, p99: 30 });
  assert.deepEqual(summary.prices, { n: 1, p50: 5000, p95: 5000, p99: 5000 });
  assert.deepEqual(summary["market:trade"], { n: 2, p50: 10, p95: 30, p99: 30 });
});
