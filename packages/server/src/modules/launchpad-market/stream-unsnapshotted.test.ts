import assert from "node:assert/strict";
import test from "node:test";
import { MarketStreamRelay } from "./stream-relay.ts";
import type { RelaySocket } from "./stream-relay.ts";

// The reader streams tracked venue pools (the SUI/USDC pool) but sends no snapshot for them.
const fingerprint = "a".repeat(64);
const POOL = `cetus:0x${"1".repeat(64)}`;
const OTHER = `cetus:0x${"2".repeat(64)}`;
const provenance = (checkpoint: number) => ({
  network: "mainnet", deployment_fingerprint: fingerprint, checkpoint,
  timestamp_ms: checkpoint * 1_000, observed_ms: checkpoint * 1_000, lag_ms: 0,
});
const envelope = (checkpoint: number, cursor: string) => ({ checkpoint, timestamp_ms: checkpoint * 1_000, cursor, provenance: provenance(checkpoint) });
const snapshot = (pool: string, checkpoint: number) => ({ type: "snapshot", topic: `pool:${pool}`, ...envelope(checkpoint, `${checkpoint}:0:0:0`) });
const lifecycle = (pool: string, checkpoint: number, event = 0) => ({ type: "lifecycle", pool_key: pool, ...envelope(checkpoint, `${checkpoint}:0:${event}:0`) });

class Socket implements RelaySocket {
  sent: Record<string, unknown>[] = [];
  closed = 0;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed++; }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]);
  }
  drop() { this.onclose?.({} as Parameters<NonNullable<RelaySocket["onclose"]>>[0]); }
}

function harness() {
  const sockets: Socket[] = [];
  const relay = new MarketStreamRelay(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  }, { network: "mainnet", deployment: fingerprint });
  const join = (query: string) => {
    const events: { event: string; data: Record<string, unknown>; id?: string }[] = [];
    const client = { events, closed: false };
    relay.subscribe(new Request(`https://frontend.test/api/launchpad/market/stream?${query}`), {
      send: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        events.push({ event: text.match(/^event: (.+)$/m)![1]!, data: JSON.parse(text.match(/^data: (.+)$/m)![1]!), id: text.match(/^id: (.+)$/m)?.[1] });
        return true;
      },
      close: () => { client.closed = true; },
    });
    return client;
  };
  const hello = (socket: Socket) => {
    socket.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    socket.receive({ type: "pong" });
  };
  const after = (client: ReturnType<typeof join>, from: number) =>
    client.events.slice(from).filter(({ event }) => event !== "heartbeat").map(({ event, data, id }) => [event, event === "status" ? `${data.state}@${data.cursor}` : id]);
  return { sockets, join, hello, after };
}

test("a pool the reader never snapshots fences at its first whole checkpoint and keeps other pools live", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}`);
  const other = join(`pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(OTHER, 9));
  const start = browser.events.length;
  sockets[0]!.receive(lifecycle(POOL, 10, 0));
  sockets[0]!.receive(lifecycle(POOL, 10, 1));
  assert.deepEqual(after(browser, start), [], "checkpoint 10 may still have frames: no fence yet");
  sockets[0]!.receive(lifecycle(POOL, 11, 0));
  sockets[0]!.receive(lifecycle(POOL, 12, 0));
  assert.deepEqual(after(browser, start), [
    ["status", "live@10:0:1:0"],
    ["market", "11:0:0:0"],
    ["market", "12:0:0:0"],
  ]);
  assert.equal(browser.closed, false);
  assert.equal(other.closed, false, "an unsnapshotted pool never ends the relay");
  assert.equal(other.events.some(({ event }) => event === "resync"), false);
  t.mock.timers.tick(10_000);
  assert.equal(browser.closed, false, "the fence clears the snapshot deadline");
});

test("malformed and repeated frames before the fence are dropped, not fatal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}`);
  hello(sockets[0]!);
  const start = browser.events.length;
  sockets[0]!.receive({ type: "trade", pool_key: POOL, ...envelope(10, "10:0:0:0"), trade: { kind: "nonsense", pool_key: POOL } });
  sockets[0]!.receive(lifecycle(POOL, 10, 1));
  sockets[0]!.receive(lifecycle(POOL, 10, 1));
  sockets[0]!.receive(lifecycle(POOL, 9, 0));
  sockets[0]!.receive(lifecycle(POOL, 11, 0));
  assert.deepEqual(after(browser, start), [["status", "live@10:0:1:0"], ["market", "11:0:0:0"]]);
  assert.equal(browser.closed, false);
});

test("a quiet unsnapshotted pool still stalls to unavailable, and an upstream loss forgets its partial checkpoint", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const quiet = join(`pool=${POOL}`);
  hello(sockets[0]!);
  sockets[0]!.receive(lifecycle(POOL, 10, 0));
  sockets[0]!.drop();
  t.mock.timers.tick(400);
  hello(sockets[1]!);
  const start = quiet.events.length;
  // Frames of checkpoint 10 may have been lost with the old socket: 10 cannot be the fence.
  sockets[1]!.receive(lifecycle(POOL, 11, 0));
  assert.equal(quiet.events.slice(start).some(({ event }) => event === "status" || event === "market"), false);
  for (let second = 0; second < 10; second++) {
    t.mock.timers.tick(1_000);
    sockets[1]!.receive({ type: "pong" });
  }
  assert.equal(sockets.length, 2, "the upstream stayed up");
  assert.equal(quiet.closed, true);
  assert.deepEqual(quiet.events.at(-1), { event: "status", data: { state: "unavailable", pool_key: POOL }, id: undefined });
});

test("after an upstream drop a boundary-fenced pool subscribes fresh and fences again, with no resync", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(OTHER, 9));
  sockets[0]!.receive(lifecycle(POOL, 10));
  sockets[0]!.receive(lifecycle(POOL, 11));
  sockets[0]!.drop();
  t.mock.timers.tick(400);
  hello(sockets[1]!);
  const subscribes = sockets[1]!.sent.filter((op) => op.op === "subscribe");
  assert.ok(subscribes.every((op) => !op.cursor || !(op.topics as string[]).includes(`pool:${POOL}`)), "no cursor resume for the pool");
  assert.ok(subscribes.some((op) => (op.topics as string[]).includes(`pool:${POOL}`)), "a plain subscribe instead");
  sockets[1]!.receive({ type: "resume_complete", cursor: "12:0:0:0" });
  sockets[1]!.receive(snapshot(OTHER, 12));
  const start = browser.events.length;
  sockets[1]!.receive(lifecycle(POOL, 13));
  sockets[1]!.receive(lifecycle(POOL, 14));
  for (let second = 0; second < 10; second++) {
    t.mock.timers.tick(1_000);
    sockets[1]!.receive({ type: "pong" });
  }
  assert.deepEqual(after(browser, start).filter(([, cursor]) => String(cursor).includes(":")), [
    ["status", "live@13:0:0:0"],
    ["market", "14:0:0:0"],
  ]);
  assert.equal(browser.events.some(({ event }) => event === "resync"), false);
  assert.equal(browser.closed, false);
});

/** Ten seconds of a live upstream: every ping answered, `each` run once a second. */
function liveFor(t: import("node:test").TestContext, socket: Socket, each: (second: number) => void = () => {}) {
  for (let second = 1; second <= 10; second++) {
    t.mock.timers.tick(1_000);
    socket.receive({ type: "pong" });
    each(second);
  }
}

// The SUI page: busy Cetus beside quiet Bluefin. The browser gives up on an unfenced pool 10 s after
// its hello, so the quiet pool must be fenced by the busy pool's traffic, not at the relay's stall.
test("a quiet pool beside an active one is fenced by the active pool's first frame, and the client stays", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  const start = browser.events.length;
  sockets[0]!.receive(lifecycle(OTHER, 11));
  assert.deepEqual(after(browser, start), [["status", "live@11:0:0:0"]], "fenced at once, before any timer");
  liveFor(t, sockets[0]!, (second) => sockets[0]!.receive(lifecycle(OTHER, 11 + second)));
  assert.equal(browser.closed, false, "the quiet pool does not end the client");
  assert.equal(browser.events.some(({ data }) => data.state === "unavailable"), false);
  sockets[0]!.receive(lifecycle(POOL, 22));
  assert.deepEqual(after(browser, browser.events.length - 1), [["market", "22:0:0:0"]], "its trades then stream");
});

test("a pool's own frame is fenced when another pool's later checkpoint begins", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const onPool = join(`pool=${POOL}`);
  hello(sockets[0]!);
  join(`pool=${OTHER}`);
  const start = onPool.events.length;
  sockets[0]!.receive(lifecycle(POOL, 11));
  sockets[0]!.receive(lifecycle(OTHER, 11, 1));
  assert.deepEqual(after(onPool, start), [], "checkpoint 11 may still hold more of the pool's events");
  sockets[0]!.receive(lifecycle(OTHER, 12));
  assert.deepEqual(after(onPool, start), [["status", "live@11:0:0:0"]]);
});

test("a quiet pool is fenced only by frames after a pong to a ping sent after its subscribe", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  join(`pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(OTHER, 10));
  const late = join(`pool=${POOL}`);
  const start = late.events.length;
  sockets[0]!.receive(lifecycle(OTHER, 11)); // May predate the reader registering POOL.
  sockets[0]!.receive({ type: "pong" }); // Answers the ping already in flight at the subscribe.
  sockets[0]!.receive(lifecycle(OTHER, 12));
  assert.deepEqual(after(late, start), []);
  t.mock.timers.tick(4_000); // The next heartbeat ping, sent after the subscribe.
  sockets[0]!.receive({ type: "pong" });
  sockets[0]!.receive(lifecycle(OTHER, 13));
  assert.deepEqual(after(late, start), [["status", "live@13:0:0:0"]]);
});

test("a ping lost with the upstream does not hold back quiet fences after the reconnect", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.drop(); // A ping is in flight.
  t.mock.timers.tick(400);
  hello(sockets[1]!);
  const start = browser.events.length;
  sockets[1]!.receive(lifecycle(OTHER, 11));
  assert.deepEqual(after(browser, start), [["status", "live@11:0:0:0"]]);
});
