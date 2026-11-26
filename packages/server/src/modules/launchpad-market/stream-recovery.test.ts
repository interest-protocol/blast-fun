import assert from "node:assert/strict";
import test from "node:test";
import { MarketStreamRelay } from "./stream-relay.ts";
import type { RelaySocket } from "./stream-relay.ts";

// Per-pool recovery: no pool fault, and no upstream fault, ends a browser's socket.
const fingerprint = "a".repeat(64);
const POOL = `cetus:0x${"1".repeat(64)}`;
const OTHER = `cetus:0x${"2".repeat(64)}`;
const provenance = (checkpoint: number, deployment = fingerprint) => ({
  network: "mainnet", deployment_fingerprint: deployment, checkpoint,
  timestamp_ms: checkpoint * 1_000, observed_ms: checkpoint * 1_000, lag_ms: 0,
});
const envelope = (checkpoint: number, cursor: string) => ({ checkpoint, timestamp_ms: checkpoint * 1_000, cursor, provenance: provenance(checkpoint) });
const snapshot = (pool: string, checkpoint: number) => ({ type: "snapshot", topic: `pool:${pool}`, ...envelope(checkpoint, `${checkpoint}:0:0:0`) });
const lifecycle = (pool: string, checkpoint: number) => ({ type: "lifecycle", pool_key: pool, ...envelope(checkpoint, `${checkpoint}:0:0:0`) });

class Socket implements RelaySocket {
  sent: Record<string, unknown>[] = [];
  closed = 0;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed++; }
  raw(data: string) {
    this.onmessage?.({ data } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]);
  }
  receive(frame: Record<string, unknown>) { this.raw(JSON.stringify(frame)); }
  drop() { this.onclose?.({} as Parameters<NonNullable<RelaySocket["onclose"]>>[0]); }
  /** The pool operations sent since `from`, pings left out. */
  ops(from: number) { return this.sent.slice(from).filter(({ op }) => op !== "ping").map(({ op, topics }) => `${op} ${(topics as string[]).join(",")}`); }
}

function harness() {
  const sockets: Socket[] = [];
  const relay = new MarketStreamRelay(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  }, { network: "mainnet", deployment: fingerprint });
  const join = (query: string) => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const client = { events, closed: false, statuses: () => events.filter(({ event }) => event === "status").map(({ data }) => data) };
    relay.subscribe(new Request(`https://frontend.test/api/launchpad/market/stream?${query}`), {
      send: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        events.push({ event: text.match(/^event: (.+)$/m)![1]!, data: JSON.parse(text.match(/^data: (.+)$/m)![1]!) });
        return true;
      },
      close: () => { client.closed = true; },
    });
    return client;
  };
  const hello = (socket: Socket, pong: Record<string, unknown> = {}) => {
    socket.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    socket.receive({ type: "pong", ...pong });
  };
  return { sockets, join, hello };
}

/** Lets `ms` pass on a live upstream: every ping answered. */
function run(t: import("node:test").TestContext, socket: Socket, ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    t.mock.timers.tick(Math.min(1_000, left));
    socket.receive({ type: "pong" });
  }
}

const recovering = (pool: string) => ({ state: "recovering", pool_key: pool });

test("an error naming its topics re-fences only those pools, with a growing wait between tries", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  const socket = sockets[0]!;
  socket.receive(snapshot(OTHER, 10));
  const waits: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const from = socket.sent.length;
    socket.receive({ type: "error", topics: [`pool:${POOL}`], error: { code: "not_ready", message: "busy" } });
    assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`]);
    t.mock.timers.tick(0);
    let waited = 0;
    while (socket.ops(from).length < 2) {
      run(t, socket, 1_000);
      waited += 1_000;
    }
    waits.push(waited);
    assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`, `subscribe pool:${POOL}`]);
  }
  assert.deepEqual(waits, [0, 5_000, 10_000, 30_000, 30_000]);
  assert.deepEqual(browser.statuses().filter(({ state }) => state === "recovering"), [recovering(POOL)], "told once");
  socket.receive(snapshot(POOL, 12));
  assert.equal(browser.statuses().at(-1)!.cursor, "12:0:0:0");
  socket.receive(lifecycle(OTHER, 13));
  assert.equal(browser.events.at(-1)!.event, "market", "the other pool streamed throughout");
  assert.equal(browser.closed, false);
  assert.equal(socket.closed, 0);
});

test("an older reader's topic-less not_ready re-fences the pools still waiting, and keeps the upstream", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const fenced = join(`pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive({ type: "error", code: "topic_forbidden" }); // answers the feed subscribe
  sockets[0]!.receive(snapshot(OTHER, 10));
  const waiting = join(`pool=${POOL}`);
  const from = sockets[0]!.sent.length;
  sockets[0]!.receive({ type: "error", error: { code: "not_ready", message: "busy" } });
  t.mock.timers.tick(0);
  assert.deepEqual(sockets[0]!.ops(from), [`unsubscribe pool:${POOL}`, `subscribe pool:${POOL}`]);
  assert.deepEqual(waiting.statuses().at(-1), recovering(POOL));
  assert.equal(fenced.statuses().some(({ state }) => state === "recovering"), false);
  assert.equal(sockets[0]!.closed, 0);
  assert.equal(waiting.closed || fenced.closed, false);
});

test("snapshot_unavailable: `unavailable` tries again, `not_found` tells only that pool and asks every minute", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}`);
  const other = join(`pool=${OTHER}`);
  hello(sockets[0]!);
  const socket = sockets[0]!;
  socket.receive(snapshot(OTHER, 10));
  let from = socket.sent.length;
  socket.receive({ type: "snapshot_unavailable", topic: `pool:${POOL}`, reason: "unavailable" });
  t.mock.timers.tick(0);
  assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`, `subscribe pool:${POOL}`]);
  assert.deepEqual(browser.statuses().at(-1), recovering(POOL));

  from = socket.sent.length;
  socket.receive({ type: "snapshot_unavailable", topic: `pool:${POOL}`, reason: "not_found" });
  assert.deepEqual(browser.statuses().at(-1), { state: "unavailable", pool_key: POOL });
  assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`], "the reader's topic slot is freed");
  run(t, socket, 59_999);
  assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`]);
  run(t, socket, 1);
  assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`, `subscribe pool:${POOL}`]);
  socket.receive({ type: "snapshot_unavailable", topic: `pool:${POOL}`, reason: "not_found" });
  assert.equal(browser.statuses().filter(({ state }) => state === "unavailable").length, 1, "told once");
  run(t, socket, 60_000);
  socket.receive(snapshot(POOL, 80));
  assert.equal(browser.statuses().at(-1)!.state, "live", "a pool the reader learns about goes live");
  assert.equal(other.statuses().some(({ pool_key }) => pool_key === POOL), false);
  assert.equal(browser.closed || other.closed, false);
});

test("a bad frame for one pool drops it and re-fences that pool, backing off while it repeats; others stream on", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  const socket = sockets[0]!;
  const bad = [
    { type: "candle_closed", pool_key: POOL, interval: "1m", candle: {}, ...envelope(11, "11:0:0:0") },
    { ...lifecycle(POOL, 11), pad: "x".repeat(20_000) },
    lifecycle(POOL, 9),
    { ...lifecycle(POOL, 11), checkpoint: 12 },
  ];
  const waits: number[] = [];
  for (const [index, frame] of bad.entries()) {
    socket.receive(snapshot(POOL, 10));
    socket.receive(snapshot(OTHER, 10 + index));
    const events = browser.events.length;
    const from = socket.sent.length;
    socket.receive(frame);
    assert.deepEqual(browser.events.slice(events).map(({ data }) => data), [recovering(POOL)], `frame ${index}`);
    t.mock.timers.tick(0);
    let waited = 0;
    while (socket.ops(from).length < 2) {
      run(t, socket, 1_000);
      waited += 1_000;
    }
    waits.push(waited);
    assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`, `subscribe pool:${POOL}`], `frame ${index}`);
  }
  assert.deepEqual(waits, [0, 5_000, 10_000, 30_000], "a fence that faults at once does not restart the backoff");
  socket.receive(snapshot(POOL, 40));
  run(t, socket, 60_000);
  const from = socket.sent.length;
  socket.receive(lifecycle(POOL, 9));
  t.mock.timers.tick(0);
  assert.deepEqual(socket.ops(from), [`unsubscribe pool:${POOL}`, `subscribe pool:${POOL}`], "a fence that held a minute does");
  socket.receive(lifecycle(OTHER, 120));
  assert.equal(browser.events.at(-1)!.event, "market");
  assert.equal(socket.closed, 0);
  assert.equal(browser.closed, false);
});

for (const [shape, refusal] of [
  ["an older reader's", { type: "error", error: { code: "not_ready", message: "busy" } }],
  ["a newer reader's", { type: "error", topics: ["activity", `pool:${POOL}`], error: { code: "not_ready", message: "busy" } }],
] as const)
  test(`${shape} refused hello subscribe reconnects, so activity is subscribed again`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
    const { sockets, join } = harness();
    const browser = join(`pool=${POOL}&activity=true`);
    sockets[0]!.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    sockets[0]!.receive(refusal);
    assert.equal(sockets[0]!.closed, 1);
    t.mock.timers.tick(400);
    sockets[1]!.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    assert.ok(sockets[1]!.ops(0).some((op) => op.startsWith("subscribe activity")));
    assert.equal(browser.closed, false);
  });

test("a frame no pool can be blamed for reconnects the upstream; another deployment's frame ends the browsers", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(POOL, 10));
  sockets[0]!.raw("{not json");
  assert.equal(sockets[0]!.closed, 1);
  assert.equal(browser.closed, false);
  t.mock.timers.tick(400);
  hello(sockets[1]!);
  sockets[1]!.receive({ ...lifecycle(POOL, 11), provenance: provenance(11, "b".repeat(64)) });
  assert.equal(browser.closed, true);
  assert.deepEqual(browser.events.at(-1)!.data, { reason: "contract-violation" });
});

test("stale needs a reader whose pongs carry market_checkpoint, and clears on progress", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const old = harness();
  const quiet = old.join(`pool=${POOL}`);
  old.hello(old.sockets[0]!);
  for (let second = 0; second < 60; second++) {
    t.mock.timers.tick(1_000);
    old.sockets[0]!.receive({ type: "pong" });
  }
  assert.equal(quiet.statuses().some(({ state }) => state === "stale"), false, "a quiet market on an older reader is not a fault");

  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}`);
  hello(sockets[0]!, { market_checkpoint: 5 });
  sockets[0]!.receive(snapshot(POOL, 5));
  for (let second = 0; second < 30; second++) {
    t.mock.timers.tick(1_000);
    sockets[0]!.receive({ type: "pong", market_checkpoint: 5 });
  }
  assert.equal(browser.statuses().some(({ state }) => state === "stale"), false);
  t.mock.timers.tick(4_000);
  sockets[0]!.receive({ type: "pong", market_checkpoint: 5 });
  assert.deepEqual(browser.statuses().at(-1), { state: "stale" });
  t.mock.timers.tick(4_000);
  sockets[0]!.receive({ type: "pong", market_checkpoint: 6 });
  assert.deepEqual(browser.statuses().at(-1), { state: "fresh" });
  assert.equal(browser.closed, false);
});

test("while the upstream reconnects, browsers are told and keep heartbeats for 30 s, then fresh on return", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(POOL, 10));
  sockets[0]!.drop();
  assert.deepEqual(browser.statuses().at(-1), { state: "recovering" });
  const beats = (from: number) => browser.events.slice(from).filter(({ event }) => event === "heartbeat").length;
  let from = browser.events.length;
  t.mock.timers.tick(29_000); // reconnect attempts that never finish their handshake
  assert.ok(beats(from) >= 6, "heartbeats every 4 s keep older browsers from reconnecting");
  t.mock.timers.tick(2_000);
  from = browser.events.length;
  t.mock.timers.tick(20_000);
  assert.equal(beats(from), 0, "after 30 s older browsers fall back on their own");
  assert.equal(browser.closed, false);
  while (sockets.at(-1)!.closed) t.mock.timers.tick(100);
  hello(sockets.at(-1)!);
  assert.deepEqual(browser.statuses().at(-1), { state: "fresh" });
});
