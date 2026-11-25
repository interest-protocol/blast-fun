import assert from "node:assert/strict";
import test from "node:test";

import { beginMarketHints, marketHintTransport } from "./market-hints.ts";

const HELLO = JSON.stringify({ type: "hello", provenance: { network: "mainnet", deployment_fingerprint: "a".repeat(64), checkpoint: 10, timestamp_ms: 1_000, observed_ms: 1_020, lag_ms: 20 } });
const PONG = JSON.stringify({ type: "pong" });
const ACTIVITY = JSON.stringify({ type: "activity", activity_id: "row-1" });
function activityOnly() {
  let opened = 0;
  let closed = 0;
  const create = () => {
    opened++;
    return { send: () => {}, close: () => { closed++; }, onmessage: null, onclose: null };
  };
  return { create, opened: () => opened, closed: () => closed };
}

test("a starting market stream is waited for: its hello takes the hints, no activity-only socket opens", () => {
  const carrier = beginMarketHints();
  const fallback = activityOnly();
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

// This fails if a tab with a market stream ever holds a second socket for its hints.
test("while a market stream exists its hints wait for it, however long; the activity-only socket opens once it ends", async () => {
  const carrier = beginMarketHints();
  const fallback = activityOnly();
  const hints = marketHintTransport("/hints", fallback.create);
  let disconnected = 0;
  hints.onclose = () => { disconnected++; };
  carrier.disconnected(); // a missed hello deadline, a refusal or a pause
  await Promise.resolve();
  assert.equal(fallback.opened(), 0);
  assert.equal(disconnected, 0, "a client still choosing keeps waiting");
  const later = marketHintTransport("/hints", fallback.create);
  await Promise.resolve();
  assert.equal(fallback.opened(), 0, "a new client waits too");
  later.onclose = () => { disconnected++; };
  carrier.stop();
  assert.equal(fallback.opened(), 2, "with no market stream left, each client opens its own path");
  assert.equal(disconnected, 0);
  hints.close();
  later.close();
});

test("with no market stream the legacy stream opens after the current task, unless one starts in it", async () => {
  const fallback = activityOnly();
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

// This fails if a hint surface that mounts before the chart keeps its own socket beside the chart's.
test("a chart that starts after the hint client closes its activity-only socket at once", async () => {
  const fallback = activityOnly();
  const hints = marketHintTransport("/hints", fallback.create);
  let disconnected = 0;
  hints.onclose = () => { disconnected++; };
  await Promise.resolve();
  assert.equal(fallback.opened(), 1);
  const carrier = beginMarketHints();
  assert.equal(fallback.closed(), 1, "the activity-only socket closes before the market socket's hello");
  assert.equal(disconnected, 1, "the client reconnects, and then waits for the market stream");
  const retry = marketHintTransport("/hints", fallback.create);
  await Promise.resolve();
  carrier.frame(HELLO);
  assert.equal(fallback.opened(), 1, "one socket in the tab");
  retry.close();
  carrier.stop();
});

test("late hint subscribers reuse the market handshake without another connection or cached activity", async () => {
  const carrier = beginMarketHints();
  carrier.frame(HELLO);
  carrier.frame(PONG);
  carrier.frame(ACTIVITY);
  const fallback = activityOnly();
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

// This fails if a market reconnect opens an activity-only socket beside the market socket it is reopening.
test("a market drop and reconnect opens no activity-only socket: the hints wait for the new hello", async () => {
  const carrier = beginMarketHints();
  carrier.frame(HELLO);
  carrier.frame(PONG);
  const fallback = activityOnly();
  const hints = marketHintTransport("/hints", fallback.create);
  let lost = 0;
  hints.onclose = () => { lost++; };
  await Promise.resolve();
  carrier.disconnected();
  assert.equal(lost, 1, "the client learns the stream dropped");
  const recovery = marketHintTransport("/hints", fallback.create);
  const frames: string[] = [];
  recovery.onmessage = ({ data }) => frames.push(String(data));
  recovery.onclose = () => { lost++; };
  await Promise.resolve();
  carrier.frame(HELLO);
  carrier.frame(PONG);
  carrier.frame(ACTIVITY);
  assert.deepEqual(frames, [HELLO, PONG, ACTIVITY], "the recovered stream carries the hints");
  assert.equal(fallback.opened(), 0, "no activity-only socket at any point");
  assert.equal(lost, 1);
  recovery.close();
  carrier.stop();
});

test("an old chart cannot close, invalidate or publish into its replacement's hint transport", async () => {
  const old = beginMarketHints();
  old.frame(HELLO);
  const current = beginMarketHints();
  current.frame(HELLO);
  current.frame(PONG);
  const fallback = activityOnly();
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
  const fallback = activityOnly();
  const hints = marketHintTransport("/hints", fallback.create);
  carrier.frame("invalid JSON");
  carrier.frame(HELLO.replace("mainnet", "testnet"));
  carrier.frame(" ".repeat(1_025) + HELLO);
  assert.equal(fallback.closed(), 0);
  hints.close();
  carrier.stop();
});
