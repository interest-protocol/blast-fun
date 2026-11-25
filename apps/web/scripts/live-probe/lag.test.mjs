import assert from "node:assert/strict";
import { test } from "node:test";
import { frameLag, parseSse, percentile, summarize } from "./lag.mjs";

test("parseSse keeps the unfinished tail and joins data lines", () => {
  const { events, rest } = parseSse("id: 1:0:0:0\nevent: market\ndata: {\"a\":\ndata: 1}\n\n: comment\n\nevent: heartbeat\ndata: {}\n\nevent: hint\ndata: {");
  assert.deepEqual(events, [{ event: "market", data: "{\"a\":\n1}", id: "1:0:0:0" }, { event: "heartbeat", data: "{}", id: null }]);
  assert.equal(rest, "event: hint\ndata: {");
});

test("frameLag measures receipt minus chain time, with hop offsets", () => {
  const data = JSON.stringify({ type: "trade", timestamp_ms: 1_000, cursor: "5:0:0:0", provenance: { timestamp_ms: 1_000, lag_ms: 7, picked_ms: 1_150, sent_ms: 1_160 } });
  assert.deepEqual(frameLag({ event: "market", data }, 1_400), {
    kind: "market:trade", lag_ms: 400, chain_ms: 1_000, received_ms: 1_400, cursor: "5:0:0:0", hops: { picked_ms: 150, sent_ms: 160 },
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
  const summary = summarize([{ kind: "a", lag_ms: 10 }, { kind: "a", lag_ms: 30 }, { kind: "b", lag_ms: 20 }]);
  assert.deepEqual(summary.all, { n: 3, p50: 20, p95: 30, p99: 30 });
  assert.deepEqual(summary.a, { n: 2, p50: 10, p95: 30, p99: 30 });
});
