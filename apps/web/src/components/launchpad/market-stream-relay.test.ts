import assert from "node:assert/strict";
import test from "node:test";

import { MarketStreamRelay, type MarketSubscription, type RelaySocket } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import { MarketStreamHub, type MarketEventSource, type MarketStreamState } from "./market-stream-hub.ts";

// The browser hub against the real relay: per-pool faults never end the tab's socket.
const DEPLOYMENT = "a".repeat(64);
const POOL = `cetus:0x${"1".repeat(64)}`;
const OTHER = `cetus:0x${"2".repeat(64)}`;
const expected = { network: "mainnet" as const, deployment: DEPLOYMENT };
const provenance = (checkpoint: number) => ({ network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: checkpoint * 1_000, observed_ms: checkpoint * 1_000, lag_ms: 0 });
const snapshot = (pool: string, checkpoint: number) => ({ type: "snapshot", topic: `pool:${pool}`, checkpoint, timestamp_ms: checkpoint * 1_000, cursor: `${checkpoint}:0:0:0`, provenance: provenance(checkpoint) });

/** How a fake reader answers a pool's subscribe: a snapshot, nothing at all, or a topic-less `not_ready` error. */
type ReaderMode = "snapshot" | "silent" | "not_ready";
type Reader = Readonly<{ modes: ReadonlyMap<string, ReaderMode>; tooOld?: boolean }>;

/**
 * The reader's socket. Without a `reader` the test sends every frame itself. With one it follows the
 * reader's rules: a subscribe for a topic it already holds is ignored, an unsubscribe drops the hold,
 * a resume (a subscribe with a cursor) answers `resync_required: too_old` when `tooOld`, and pings
 * answer in order. Answers wait for `pump()`, as a socket's would.
 */
class Upstream implements RelaySocket {
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  readonly held = new Set<string>();
  readonly #queue: Record<string, unknown>[] = [];
  readonly #reader: Reader | null;
  #checkpoint = 10;
  #subscribes = 0;
  constructor(reader: Reader | null) { this.#reader = reader; }
  send(text: string): void {
    if (!this.#reader) return;
    const { op, topics, cursor } = JSON.parse(text) as { op: string; topics?: string[]; cursor?: string };
    if (op === "ping") return void this.#queue.push({ type: "pong" });
    if (op === "subscribe") this.#subscribes++;
    for (const topic of topics ?? []) {
      if (op === "unsubscribe") this.held.delete(topic);
      else if (op === "subscribe" && !this.held.has(topic)) this.#answer(this.#reader, topic, cursor);
    }
  }
  #answer(reader: Reader, topic: string, cursor: string | undefined): void {
    this.held.add(topic);
    if (!topic.startsWith("pool:")) return;
    const pool = topic.slice(5);
    if (cursor && reader.tooOld) {
      this.held.delete(topic);
      this.#queue.push({ type: "resync_required", reason: "too_old", topic });
      return;
    }
    const mode = reader.modes.get(pool) ?? "snapshot";
    if (mode === "snapshot") this.#queue.push(snapshot(pool, this.#checkpoint++));
    // The reader answers the hello's subscribe with its snapshots; `not_ready` answers a later one.
    else if (mode === "not_ready" && this.#subscribes > 1) {
      this.held.delete(topic);
      this.#queue.push({ type: "error", error: { code: "not_ready" } });
    }
  }
  pump(): void { for (const frame of this.#queue.splice(0)) this.receive(frame); }
  close(): void {}
  receive(frame: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(frame) } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]); }
  drop(): void { this.onclose?.({} as Parameters<NonNullable<RelaySocket["onclose"]>>[0]); }
}

/** An EventSource fed by `relay.subscribe`; events arrive after the hub attaches its listeners. */
class RelaySource implements MarketEventSource {
  closed = false;
  url = "";
  readonly #listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  readonly #subscription: MarketSubscription;
  constructor(relay: MarketStreamRelay, url: string) {
    this.url = url;
    const subscription = relay.subscribe(new Request(`https://frontend.test${url}`), {
      send: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        const type = text.match(/^event: (.+)$/m)?.[1];
        const data = text.match(/^data: (.+)$/m)?.[1];
        if (type) queueMicrotask(() => this.#emit(type, data));
        return true;
      },
      close: () => queueMicrotask(() => { if (!this.closed) this.#emit("error", undefined); }),
    });
    assert.ok(!(subscription instanceof Response), "the relay accepts the hub's request");
    this.#subscription = subscription;
  }
  /** The server's `set` handler without its limits. */
  send(text: string): boolean {
    if (this.closed) return false;
    const { seq, pools, price_coins: priceCoins, presale } = JSON.parse(text) as { seq: number; pools: string[]; price_coins: string[]; presale: string | null };
    // As the server does: the answer goes before the relay's catch-up for the added pools.
    queueMicrotask(() => this.#emit("set", JSON.stringify({ seq, ok: true, held: { pools, price_coins: priceCoins, presale } })));
    this.#subscription.set({ pools, priceCoins, presale });
    return true;
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void { this.#listeners.set(type, [...this.#listeners.get(type) ?? [], listener]); }
  close(): void { if (this.closed) return; this.closed = true; this.#subscription.stop(); }
  #emit(type: string, data: string | undefined): void { if (!this.closed) for (const listener of this.#listeners.get(type) ?? []) listener({ data }); }
}

function harness(t: import("node:test").TestContext, reader: Reader | null = null, pools: readonly string[] = [POOL, OTHER]) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const upstreams: Upstream[] = [];
  const relay = new MarketStreamRelay(() => { const socket = new Upstream(reader); upstreams.push(socket); return socket; }, expected);
  const sources: RelaySource[] = [];
  const hub = new MarketStreamHub({
    createSource: (url) => { const source = new RelaySource(relay, url); sources.push(source); return source; },
    schedule: (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id); },
    defer: queueMicrotask, random: () => 0, visible: () => true, onVisibilityChange: () => () => {},
  });
  const states = new Map<string, MarketStreamState>();
  const fences: [string, number][] = [];
  const subscribe = (keys: readonly string[]) => hub.subscribe({ pools: keys, expected, listener: { state: () => {}, pool: (pool, state) => states.set(pool, state), fence: (pool, checkpoint) => fences.push([pool, checkpoint]) } });
  const subscription = subscribe(pools);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  /** Lets `ms` pass with the upstream answering every ping (a reader answers what it was sent). */
  const run = async (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      t.mock.timers.tick(Math.min(1_000, left));
      if (reader) upstreams.at(-1)?.pump();
      else upstreams.at(-1)?.receive({ type: "pong" });
      await flush();
    }
  };
  const hello = () => {
    upstreams.at(-1)!.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    if (reader) upstreams.at(-1)!.pump();
    else upstreams.at(-1)!.receive({ type: "pong" });
  };
  /** Ticks until the relay opened a new upstream, then greets it. */
  const reopen = async () => {
    const count = upstreams.length;
    while (upstreams.length === count) { t.mock.timers.tick(100); await flush(); }
    hello();
    await flush();
  };
  return { hub, sources, upstreams, states, fences, subscription, subscribe, flush, run, hello, reopen };
}

test("fences from the relay make each pool live", async (t) => {
  const h = harness(t);
  await h.flush();
  assert.equal(h.sources.length, 1);
  h.hello();
  h.upstreams[0]!.receive(snapshot(POOL, 10));
  h.upstreams[0]!.receive(snapshot(OTHER, 11));
  await h.flush();
  assert.deepEqual(h.fences, [[POOL, 10], [OTHER, 11]]);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.ready(OTHER), true);
  h.subscription.stop();
});

test("a pool the relay cannot find leaves the other pool live on the same socket", async (t) => {
  const h = harness(t);
  await h.flush();
  h.hello();
  h.upstreams[0]!.receive(snapshot(POOL, 10));
  h.upstreams[0]!.receive({ type: "snapshot_unavailable", topic: `pool:${OTHER}`, reason: "not_found" });
  await h.run(60_000);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "unavailable");
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0]!.closed, false);
  h.subscription.stop();
});

test("an upstream drop keeps the browser socket and re-fences both pools", async (t) => {
  const h = harness(t);
  await h.flush();
  h.hello();
  h.upstreams[0]!.receive(snapshot(POOL, 10));
  h.upstreams[0]!.receive(snapshot(OTHER, 10));
  await h.flush();
  h.upstreams[0]!.drop();
  await h.flush();
  assert.notEqual(h.subscription.state(POOL), "live");
  while (h.upstreams.length < 2) { t.mock.timers.tick(100); await h.flush(); }
  h.hello();
  h.upstreams.at(-1)!.receive(snapshot(POOL, 20));
  h.upstreams.at(-1)!.receive(snapshot(OTHER, 20));
  await h.flush();
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "live");
  await h.run(60_000);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0]!.closed, false);
  h.subscription.stop();
});

// With a fake reader that keeps the reader's rules.
const unavailable = (h: ReturnType<typeof harness>) => [...h.states.values()].includes("unavailable");

test("ten quiet minutes keep both pools live on one socket, with no unavailable", async (t) => {
  const h = harness(t, { modes: new Map() });
  await h.flush();
  h.hello();
  await h.flush();
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "live");
  await h.run(600_000);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "live");
  assert.equal(unavailable(h), false);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0]!.closed, false);
  h.subscription.stop();
});

for (const mode of ["silent", "not_ready"] as const) {
  test(`a pool the reader leaves ${mode} does not stop the other pool streaming`, async (t) => {
    const h = harness(t, { modes: new Map([[OTHER, mode]]) });
    await h.flush();
    h.hello();
    await h.run(120_000);
    assert.equal(h.subscription.state(POOL), "live");
    assert.notEqual(h.subscription.state(OTHER), "live");
    assert.equal(h.sources.length, 1);
    assert.equal(h.sources[0]!.closed, false);
  });
}

test("a third pool is over budget while the other two stream, and streams once a slot frees", async (t) => {
  const THIRD = `cetus:0x${"3".repeat(64)}`;
  const h = harness(t, { modes: new Map() });
  const newer = h.subscribe([THIRD]);
  await h.flush();
  assert.equal(h.sources.filter((source) => !source.closed).length, 1);
  h.hello();
  await h.flush();
  await h.run(1_000); // the `set` that adds the third pool, and the reader's snapshot for it
  assert.equal(newer.state(THIRD), "live", "the newest subscriber is served first");
  const served = [POOL, OTHER].filter((pool) => h.subscription.state(pool) === "live");
  const over = [POOL, OTHER].filter((pool) => h.subscription.state(pool) === "over_budget");
  assert.equal(served.length, 1);
  assert.equal(over.length, 1);
  newer.stop();
  await h.run(5_000);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "live");
  assert.equal(h.sources.length, 1, "one socket throughout: each change is a `set`");
  h.subscription.stop();
});

test("an oversized upstream frame or a reader rotation keeps the browser socket; resumes too old re-fence", async (t) => {
  const h = harness(t, { modes: new Map(), tooOld: true });
  await h.flush();
  h.hello();
  await h.flush();
  h.upstreams.at(-1)!.receive({ ...snapshot(POOL, 20), padding: "x".repeat(2_000_000) });
  await h.flush();
  assert.notEqual(h.subscription.state(POOL), "live");
  await h.reopen();
  await h.run(30_000);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "live");
  h.upstreams.at(-1)!.receive({ type: "reconnect" });
  await h.reopen();
  await h.run(30_000);
  assert.equal(h.subscription.state(POOL), "live");
  assert.equal(h.subscription.state(OTHER), "live");
  assert.equal(unavailable(h), false);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0]!.closed, false);
  h.subscription.stop();
});
