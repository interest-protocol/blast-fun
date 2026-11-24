import assert from "node:assert/strict";
import test from "node:test";

import { beginMarketHints, marketHintTransport } from "./market-hints.ts";

const HELLO = JSON.stringify({ type: "hello", provenance: { network: "mainnet", deployment_fingerprint: "a".repeat(64), checkpoint: 10, timestamp_ms: 1_000, observed_ms: 1_020, lag_ms: 20 } });
const PONG = JSON.stringify({ type: "pong" });
const ACTIVITY = JSON.stringify({ type: "activity", activity_id: "row-1" });
function legacy() {
  let opened = 0;
  let closed = 0;
  const create = () => {
    opened++;
    return { send: () => {}, close: () => { closed++; }, onmessage: null, onclose: null };
  };
  return { create, opened: () => opened, closed: () => closed };
}

test("a starting market stream is waited for: its hello takes the hints, no legacy connection opens", () => {
  const carrier = beginMarketHints();
  const fallback = legacy();
  const hints = marketHintTransport("/hints", fallback.create);
  const frames: string[] = [];
  hints.onmessage = ({ data }) => frames.push(String(data));
  let disconnected = 0;
  hints.onclose = () => { disconnected++; };
  carrier.frame(ACTIVITY);
  assert.deepEqual(frames, [], "activity before its handshake cannot seize the transport");
  carrier.frame(HELLO);
  carrier.frame(PONG);
  carrier.frame(ACTIVITY);
  assert.deepEqual(frames, [HELLO, PONG, ACTIVITY]);
  assert.equal(fallback.opened(), 0);
  assert.equal(disconnected, 0);
  hints.close();
  carrier.stop();
});

test("a market stream that misses its hello deadline hands the hints to the legacy stream", () => {
  const carrier = beginMarketHints();
  const fallback = legacy();
  const hints = marketHintTransport("/hints", fallback.create);
  carrier.disconnected();
  assert.equal(fallback.opened(), 1);
  const later = marketHintTransport("/hints", fallback.create);
  assert.equal(fallback.opened(), 2, "a lost market stream is not waited for again");
  let disconnected = 0;
  hints.onclose = () => { disconnected++; };
  later.onclose = () => { disconnected++; };
  carrier.frame(HELLO);
  assert.equal(fallback.closed(), 2);
  assert.equal(disconnected, 2, "ActivityHints reconnects and catches up after ownership changes");
  carrier.stop();
});

test("with no market stream the legacy stream opens after the current task, unless one starts in it", async () => {
  const fallback = legacy();
  const alone = marketHintTransport("/hints", fallback.create);
  assert.equal(fallback.opened(), 0);
  await Promise.resolve();
  assert.equal(fallback.opened(), 1);
  alone.close();
  const beside = marketHintTransport("/hints", fallback.create);
  const carrier = beginMarketHints(); // a chart mounting in the same commit
  await Promise.resolve();
  assert.equal(fallback.opened(), 1);
  carrier.frame(HELLO);
  assert.equal(fallback.opened(), 1);
  beside.close();
  carrier.stop();
});

test("late hint subscribers reuse the market handshake without another connection or cached activity", async () => {
  const carrier = beginMarketHints();
  carrier.frame(HELLO);
  carrier.frame(PONG);
  carrier.frame(ACTIVITY);
  const fallback = legacy();
  const hints = marketHintTransport("/hints", fallback.create);
  const frames: string[] = [];
  hints.onmessage = ({ data }) => frames.push(String(data));
  await Promise.resolve();
  assert.deepEqual(frames, [HELLO, PONG]);
  assert.equal(fallback.opened(), 0);
  carrier.frame(ACTIVITY);
  assert.deepEqual(frames, [HELLO, PONG, ACTIVITY]);
  hints.close();
  carrier.stop();
});

test("market loss restores healthy legacy hints, then a new handshake takes over again", async () => {
  const carrier = beginMarketHints();
  carrier.frame(HELLO);
  carrier.frame(PONG);
  const fallback = legacy();
  const hints = marketHintTransport("/hints", fallback.create);
  let lost = 0;
  hints.onclose = () => { lost++; };
  await Promise.resolve();
  carrier.disconnected();
  assert.equal(lost, 1);
  const recovery = marketHintTransport("/hints", fallback.create);
  recovery.onclose = () => { lost++; };
  assert.equal(fallback.opened(), 1);
  carrier.frame(HELLO);
  assert.equal(lost, 2);
  assert.equal(fallback.closed(), 1);
  recovery.close();
  carrier.stop();
});

test("an old chart cannot close, invalidate or publish into its replacement's hint transport", async () => {
  const old = beginMarketHints();
  old.frame(HELLO);
  const current = beginMarketHints();
  current.frame(HELLO);
  current.frame(PONG);
  const fallback = legacy();
  const hints = marketHintTransport("/hints", fallback.create);
  const frames: string[] = [];
  hints.onmessage = ({ data }) => frames.push(String(data));
  let lost = 0;
  hints.onclose = () => { lost++; };
  old.disconnected();
  old.stop();
  old.frame(ACTIVITY);
  await Promise.resolve();
  assert.equal(lost, 0);
  assert.deepEqual(frames, [HELLO, PONG]);
  current.frame(ACTIVITY);
  assert.equal(frames.at(-1), ACTIVITY);
  assert.equal(fallback.opened(), 0);
  hints.close();
  current.stop();
});

test("invalid, oversized and non-mainnet handshakes cannot replace a healthy hint connection", () => {
  const carrier = beginMarketHints();
  const fallback = legacy();
  const hints = marketHintTransport("/hints", fallback.create);
  carrier.frame("invalid JSON");
  carrier.frame(HELLO.replace("mainnet", "testnet"));
  carrier.frame(" ".repeat(1_025) + HELLO);
  assert.equal(fallback.closed(), 0);
  hints.close();
  carrier.stop();
});
