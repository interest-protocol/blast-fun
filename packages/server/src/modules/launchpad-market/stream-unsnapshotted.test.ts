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

// The reader snapshots every pool it streams (blast-infra #289), tracked SUI/USDC venue pools too:
// the relay never guesses a fence from traffic.

test("frames before a pool's snapshot are dropped; the snapshot fences it", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  const start = browser.events.length;
  sockets[0]!.receive(lifecycle(OTHER, 10));
  sockets[0]!.receive(lifecycle(POOL, 10));
  sockets[0]!.receive(lifecycle(OTHER, 11));
  assert.deepEqual(after(browser, start), [], "no fence is guessed from traffic");
  sockets[0]!.receive(snapshot(POOL, 11));
  sockets[0]!.receive(lifecycle(POOL, 12));
  assert.deepEqual(after(browser, start), [["status", "live@11:0:0:0"], ["market", "12:0:0:0"]]);
  assert.equal(browser.closed, false);
});

test("a quiet pool with no snapshot in 10 s re-fences itself; other pools stream on", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, after } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(OTHER, 9));
  const sent = sockets[0]!.sent.length;
  for (let second = 0; second < 10; second++) {
    t.mock.timers.tick(1_000);
    sockets[0]!.receive({ type: "pong" });
  }
  assert.deepEqual(browser.events.filter(({ event }) => event === "status").at(-1)?.data, { state: "recovering", pool_key: POOL });
  assert.deepEqual(sockets[0]!.sent.slice(sent).filter(({ op }) => op !== "ping"), [
    { op: "unsubscribe", topics: [`pool:${POOL}`] },
    { op: "subscribe", topics: [`pool:${POOL}`] },
  ]);
  const start = browser.events.length;
  sockets[0]!.receive(lifecycle(OTHER, 10));
  sockets[0]!.receive(snapshot(POOL, 10));
  assert.deepEqual(after(browser, start), [["market", "10:0:0:0"], ["status", "live@10:0:0:0"]]);
});

// HELMET: a quiet pool after an upstream drop resumes from its cursor; the trailing snapshot ends the resume.
test("after an upstream drop a quiet pool resumes by cursor and stays live", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(POOL, 9));
  sockets[0]!.drop();
  t.mock.timers.tick(400);
  hello(sockets[1]!);
  assert.ok(sockets[1]!.sent.some((op) => op.op === "subscribe" && op.cursor === "9:0:0:0"), "resumes from its cursor");
  sockets[1]!.receive({ type: "resume_complete", cursor: "9:0:0:0" });
  sockets[1]!.receive(snapshot(POOL, 30));
  for (let second = 0; second < 180; second++) {
    t.mock.timers.tick(1_000);
    sockets[1]!.receive({ type: "pong" });
  }
  assert.equal(browser.events.some(({ data }) => data.pool_key === POOL && data.state === "recovering"), false);
  assert.equal(browser.closed, false);
});
