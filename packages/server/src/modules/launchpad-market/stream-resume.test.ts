import assert from "node:assert/strict";
import test from "node:test";
import { MarketStreamRelay } from "./stream-relay.ts";
import type { RelaySocket } from "../social/activity/hint-relay.ts";

const fingerprint = "a".repeat(64);
const POOL = `cetus:0x${"1".repeat(64)}`;
const OTHER = `cetus:0x${"2".repeat(64)}`;
const provenance = (checkpoint: number) => ({
  network: "mainnet", deployment_fingerprint: fingerprint, checkpoint,
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
  const join = (query: string, options?: Parameters<MarketStreamRelay["subscribe"]>[2]) => {
    const events: { event: string; data: Record<string, unknown>; id?: string }[] = [];
    const client = { events, closed: false };
    relay.subscribe(new Request(`https://frontend.test/api/launchpad/market/stream?${query}`), {
      send: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        events.push({ event: text.match(/^event: (.+)$/m)![1]!, data: JSON.parse(text.match(/^data: (.+)$/m)![1]!), id: text.match(/^id: (.+)$/m)?.[1] });
        return true;
      },
      close: () => { client.closed = true; },
    }, options);
    return client;
  };
  const hello = (socket: Socket) => {
    socket.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    socket.receive({ type: "pong" });
  };
  return { relay, sockets, join, hello };
}

test("an upstream drop keeps browsers connected and resumes each fenced pool from its cursor", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const browser = join(`pool=${POOL}&pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(POOL, 10));
  sockets[0]!.receive(lifecycle(POOL, 11));

  sockets[0]!.drop();
  assert.equal(browser.closed, false);
  assert.equal(browser.events.some(({ event }) => event === "resync"), false);
  t.mock.timers.tick(400);
  assert.equal(sockets.length, 2, "the relay reconnects upstream by itself");
  hello(sockets[1]!);
  assert.deepEqual(
    sockets[1]!.sent.filter((op) => op.cursor),
    [{ op: "subscribe", topics: [`pool:${POOL}`], cursor: "11:0:0:0" }],
  );
  assert.ok(sockets[1]!.sent.some((op) => (op.topics as string[] | undefined)?.includes(`pool:${OTHER}`) && !op.cursor), "an unfenced pool subscribes fresh");

  const before = browser.events.length;
  sockets[1]!.receive(lifecycle(POOL, 11));
  sockets[1]!.receive(lifecycle(POOL, 12));
  sockets[1]!.receive(snapshot(POOL, 12));
  sockets[1]!.receive({ type: "resume_complete", cursor: "12:0:0:0" });
  assert.deepEqual(browser.events.slice(before).map(({ event, id }) => [event, id]), [["market", "12:0:0:0"]], "replayed frames arrive once; the resume snapshot is not a new fence");
  t.mock.timers.tick(10_000);
  assert.equal(browser.closed, false, "a finished resume clears its deadline");
});

test("a resume the reader cannot fill ends only that pool's browsers", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  const onPool = join(`pool=${POOL}`);
  const onOther = join(`pool=${OTHER}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(POOL, 10));
  sockets[0]!.receive(snapshot(OTHER, 10));
  sockets[0]!.drop();
  t.mock.timers.tick(400);
  hello(sockets[1]!);
  sockets[1]!.receive({ type: "resync_required", reason: "too_old" });
  assert.equal(onPool.closed, true);
  assert.deepEqual(onPool.events.at(-1)?.data, { reason: "too_old", pool_key: POOL });
  assert.equal(onOther.closed, false);
  assert.equal(sockets[1]!.closed, 0, "too_old answers one resume; the upstream stays open");
});

test("a browser that reconnects inside the ring gets a resumed fence and only the frames it missed", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello } = harness();
  join(`pool=${POOL}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(POOL, 10));
  for (const checkpoint of [11, 12, 13]) sockets[0]!.receive(lifecycle(POOL, checkpoint));

  const resumed = join(`pool=${POOL}`, { resume: new Map([[POOL, "11:0:0:0"]]), lifetime: false });
  assert.deepEqual(resumed.events.filter(({ event }) => event !== "status" || resumed.events.indexOf({ event, data: {} } as never) === -1).map(({ event, data, id }) => event === "status" ? [event, data.state, data.cursor, data.resumed] : [event, id]), [
    ["status", "connecting", undefined, undefined],
    ["status", "live", "11:0:0:0", true],
    ["market", "12:0:0:0"],
    ["market", "13:0:0:0"],
  ]);

  const stale = join(`pool=${POOL}`, { resume: new Map([[POOL, "9:0:0:0"]]) });
  assert.deepEqual(stale.events.at(-1)?.data.resumed, undefined, "a cursor before the ring gets a normal fence");
  t.mock.timers.tick(300_000);
  assert.equal(resumed.closed, false, "a socket subscriber has no lifetime");
  assert.equal(stale.closed, true, "SSE keeps its lifetime");
});
