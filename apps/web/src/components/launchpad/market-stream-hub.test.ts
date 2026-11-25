import assert from "node:assert/strict";
import test from "node:test";

import { marketHintTransport } from "#web/lib/live-stream/market-hints.ts";
import { HIDDEN_GRACE_MS, MarketStreamHub, STABLE_MS, UNSERVED_RETRY_MS, type MarketEventSource, type MarketStreamState, type MarketTrade } from "./market-stream-hub.ts";

const CURVE = `blast_curve:0x${"11".repeat(32)}`;
const VENUE = `cetus:0x${"22".repeat(32)}`;
const OTHER = `blast_curve:0x${"33".repeat(32)}`;
const DEPLOYMENT = "ab".repeat(32);
const NOW = 1_790_000_000_000;
const expected = { network: "mainnet" as const, deployment: DEPLOYMENT };
const wireProvenance = (checkpoint: number) => ({ network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: NOW + checkpoint, observed_ms: NOW + checkpoint + 20, lag_ms: 20, hops: { arrived_ms: NOW + checkpoint + 5, r2_put_ms: 38, written_ms: NOW + checkpoint + 15, picked_ms: NOW + checkpoint + 20 } });

function trade(checkpoint: number, part = 2, summary: unknown = { holders: checkpoint }) {
  return { type: "trade", cursor: `${checkpoint}:1:0:${part}`, checkpoint, timestamp_ms: NOW + checkpoint, provenance: wireProvenance(checkpoint), summary, trade: { cursor: `${checkpoint}:1:0:${part}`, timestamp_ms: NOW + checkpoint, digest: "1".repeat(32), pool_key: CURVE, venue: "blast_curve", trader: null, side: "buy", kind: "buy", quote_amount: "5", meme_amount: "3", price: "2", volume_usd: null, venue_swap: null } };
}

class Source implements MarketEventSource {
  closed = false;
  readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close(): void { this.closed = true; }
  emit(type: string, value: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(value) }); }
  fence(checkpoint: number, poolKey = CURVE): void { this.emit("status", { state: "live", pool_key: poolKey, checkpoint, cursor: `${checkpoint}:0:0:0`, provenance: wireProvenance(checkpoint) }); }
  hello(heartbeat = false): void { this.emit("hint", { type: "hello", provenance: wireProvenance(1), heartbeat }); }
  pools(): string[] { return new URL(this.url, "https://blast.test").searchParams.getAll("pool"); }
}

function setup() {
  const sources: Source[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  let visible = true;
  let onVisibility: (() => void) | null = null;
  const hub = new MarketStreamHub({
    createSource: (url) => { const source = new Source(url); sources.push(source); return source; },
    schedule: (run, ms) => { const timer = { run, ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; },
    defer: queueMicrotask, random: () => 0, visible: () => visible,
    onVisibilityChange: (listener) => { onVisibility = listener; return () => { onVisibility = null; }; },
  });
  const fire = (ms: number) => { const timer = timers.find((entry) => entry.ms === ms)!; assert.ok(timer, `a ${ms} ms timer is pending`); timers.splice(timers.indexOf(timer), 1); timer.run(); };
  const setVisible = (value: boolean) => { visible = value; onVisibility?.(); };
  return { hub, sources, timers, fire, setVisible, source: () => sources.at(-1)!, listening: () => onVisibility !== null };
}

function watcher(pools: string[] = [CURVE]) {
  const states: MarketStreamState[] = [];
  const fences: [string, number][] = [];
  const trades: MarketTrade[] = [];
  return { pools, states, fences, trades, listener: { state: (state: MarketStreamState) => states.push(state), fence: (pool: string, checkpoint: number) => fences.push([pool, checkpoint]), trade: (value: MarketTrade) => trades.push(value) } };
}

const settle = () => Promise.resolve();

test("two subscribers to the same pool share one EventSource, and it closes after the last leaves", async () => {
  const s = setup();
  const chart = watcher();
  const list = watcher();
  const first = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const second = s.hub.subscribe({ pools: list.pools, expected, listener: list.listener });
  await settle();
  assert.equal(s.sources.length, 1);
  assert.deepEqual(s.source().pools(), [CURVE]);
  s.source().fence(10);
  s.source().hello();
  assert.deepEqual(chart.states, ["connecting", "live"]);
  assert.deepEqual(list.states, ["connecting", "live"]);
  s.source().emit("market", trade(11));
  s.source().emit("market", trade(11)); // the same cursor again is delivered once
  assert.equal(chart.trades.length, 1);
  assert.equal(list.trades.length, 1);
  assert.deepEqual(list.trades[0].summary, { holders: 11 });
  assert.deepEqual(s.hub.summary(CURVE), { holders: 11 });
  first.stop();
  await settle();
  assert.equal(s.source().closed, false);
  second.stop();
  await settle();
  assert.equal(s.source().closed, true);
  assert.equal(s.timers.length, 0);
  assert.equal(s.listening(), false);
});

test("a legacy relay keeps its original heartbeat deadline and requires a new fence after loss", async () => {
  const s = setup();
  const chart = watcher();
  const subscription = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const old = s.source();
  old.fence(10);
  old.hello(true);
  s.fire(45_000);
  assert.equal(old.closed, true);
  assert.equal(chart.states.at(-1), "reconnecting");
  old.emit("market", trade(11));
  assert.equal(chart.trades.length, 0);

  s.fire(500);
  s.source().hello();
  s.source().fence(12);
  assert.equal(chart.states.at(-1), "live");
  assert.deepEqual(chart.fences, [[CURVE, 10], [CURVE, 12]]);
  subscription.stop();
  await settle();
  assert.equal(s.timers.length, 0);
});

test("a late subscriber to a live pool starts from what the stream already delivered", async () => {
  const s = setup();
  const early = watcher();
  s.hub.subscribe({ pools: early.pools, expected, listener: early.listener });
  s.source().fence(10);
  s.source().hello();
  s.source().emit("market", trade(14));
  const late = watcher();
  s.hub.subscribe({ pools: late.pools, expected, listener: late.listener });
  await settle();
  assert.equal(s.sources.length, 1);
  assert.deepEqual(late.states, ["live"]);
  assert.deepEqual(late.fences, [[CURVE, 14]]);
  s.source().emit("market", trade(15));
  assert.equal(late.trades.length, 1);
  assert.equal(early.trades.length, 2);
});

test("a hidden tab keeps its stream for 15 s; longer pauses it, and showing it again reconnects", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().fence(10);
  s.source().hello();
  s.setVisible(false);
  assert.ok(s.timers.some((timer) => timer.ms === HIDDEN_GRACE_MS));
  s.setVisible(true);
  assert.equal(s.timers.some((timer) => timer.ms === HIDDEN_GRACE_MS), false);
  assert.equal(s.sources.length, 1);
  assert.equal(s.source().closed, false);
  assert.deepEqual(chart.states, ["connecting", "live"]);
  s.setVisible(false);
  s.fire(HIDDEN_GRACE_MS);
  assert.equal(s.source().closed, true);
  assert.equal(chart.states.at(-1), "paused");
  s.setVisible(true);
  assert.equal(s.sources.length, 2);
  assert.equal(chart.states.at(-1), "connecting");
});

test("a pool set change reconnects once and never holds two streams", async () => {
  const s = setup();
  const coin = watcher();
  const first = s.hub.subscribe({ pools: coin.pools, expected, listener: coin.listener });
  s.source().fence(10);
  s.source().hello();
  const next = watcher([OTHER]);
  first.stop();
  s.hub.subscribe({ pools: next.pools, expected, listener: next.listener });
  await settle();
  assert.equal(s.sources.length, 2);
  assert.equal(s.sources[0].closed, true);
  assert.deepEqual(s.source().pools(), [OTHER]);
  assert.equal(s.sources.filter((source) => !source.closed).length, 1);
  assert.equal(coin.states.at(-1), "live", "a stopped subscriber hears nothing more");
});

test("a third pool beyond the two-pool budget stays on its polls", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const other = watcher([OTHER]);
  s.hub.subscribe({ pools: other.pools, expected, listener: other.listener });
  await settle();
  assert.deepEqual(s.source().pools(), [OTHER]);
  assert.equal(chart.states.at(-1), "unavailable", "the newest screen wins the stream");
  assert.equal(other.states.at(-1), "connecting");
  assert.equal(s.sources.length, 2);
  assert.equal(s.sources[0].closed, true);
});

test("a pool the stream never fences stays on its polls without fast retries; the other pool keeps streaming", async () => {
  const s = setup();
  const chart = watcher([CURVE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const unindexed = watcher([VENUE]);
  const subscription = s.hub.subscribe({ pools: unindexed.pools, expected, listener: unindexed.listener });
  await settle();
  assert.deepEqual(s.source().pools().sort(), [CURVE, VENUE].sort());
  s.source().hello();
  s.source().fence(10);
  s.fire(10_000); // The market engine never snapshots VENUE (it may not index that coin).
  assert.equal(unindexed.states.at(-1), "unavailable");
  assert.equal(s.sources[0].closed, true);
  assert.deepEqual(s.source().pools(), [CURVE]);
  assert.deepEqual(s.timers.map((timer) => timer.ms).sort(), [10_000, UNSERVED_RETRY_MS], "no backoff retry, one slow retry");
  s.source().hello();
  s.source().fence(11);
  assert.equal(chart.states.at(-1), "live");
  const opened = s.sources.length;
  subscription.restart();
  assert.equal(s.sources.length, opened, "an unserved subscriber never restarts the stream");
  const again = watcher([VENUE]);
  s.hub.subscribe({ pools: again.pools, expected, listener: again.listener });
  await settle();
  assert.deepEqual(s.source().pools().sort(), [CURVE, VENUE].sort(), "subscribing again tries the pool again");
});

test("the relay's unavailable status names one pool: only its subscribers fall back to polls", async () => {
  const s = setup();
  const unindexed = watcher([VENUE]);
  s.hub.subscribe({ pools: unindexed.pools, expected, listener: unindexed.listener });
  s.source().hello();
  s.source().emit("status", { state: "unavailable", pool_key: VENUE });
  assert.deepEqual(unindexed.states, ["connecting", "unavailable"]);
  assert.equal(s.source().closed, true);
  assert.equal(s.sources.length, 1);
  assert.deepEqual(s.timers.map((timer) => timer.ms), [UNSERVED_RETRY_MS]);
  s.fire(UNSERVED_RETRY_MS); // The engine may index the coin by now.
  assert.equal(s.sources.length, 2);
  assert.deepEqual(s.source().pools(), [VENUE]);
  s.source().hello();
  s.source().fence(10, VENUE);
  assert.equal(unindexed.states.at(-1), "live");
  assert.equal(s.listening(), true, "the reopened stream still pauses in a hidden tab");
});

test("the unserved retry never restarts a live stream for other pools, backs off, and ends with the last subscriber", async () => {
  const s = setup();
  const chart = watcher([CURVE]);
  const chartSubscription = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const unindexed = watcher([VENUE]);
  const subscription = s.hub.subscribe({ pools: unindexed.pools, expected, listener: unindexed.listener });
  await settle();
  s.source().hello();
  s.source().fence(10);
  s.fire(10_000);
  s.source().hello();
  s.source().fence(11);
  const opened = s.sources.length;
  s.fire(UNSERVED_RETRY_MS);
  assert.equal(s.sources.length, opened, "the live CURVE stream is not restarted");
  assert.equal(chart.states.at(-1), "live");
  assert.ok(s.timers.some((timer) => timer.ms === UNSERVED_RETRY_MS), "the probe waits for its turn");
  chartSubscription.stop();
  await settle();
  s.fire(UNSERVED_RETRY_MS); // Nothing healthy to disturb: the probe runs.
  assert.deepEqual(s.source().pools(), [VENUE]);
  s.source().hello();
  s.fire(10_000);
  assert.equal(unindexed.states.at(-1), "unavailable");
  assert.ok(s.timers.some((timer) => timer.ms === 2 * UNSERVED_RETRY_MS), "each failed probe doubles the wait");
  subscription.stop();
  await settle();
  assert.equal(s.timers.length, 0, "no retry outlives the last subscriber");
  assert.equal(s.listening(), false);
});

test("before the hint handshake a pool-named unavailable is an upstream fault, and the fence deadline runs from the hello", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().emit("status", { state: "unavailable", pool_key: CURVE });
  assert.deepEqual(chart.states, ["connecting", "reconnecting"]);
  s.fire(500);
  s.source().hello(); // A late hello: the pool still gets a full deadline for its fence.
  s.fire(10_000);
  assert.equal(chart.states.at(-1), "unavailable");
  assert.equal(s.timers.some((timer) => timer.ms === 10_000), false, "the handshake deadline was replaced");
});

test("without the hint handshake the deadline reconnects with backoff, as an upstream fault", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().fence(10);
  s.fire(10_000);
  assert.deepEqual(chart.states, ["connecting", "reconnecting"]);
  s.fire(500);
  assert.equal(s.sources.length, 2);
});

test("a refused stream (503 busy) is not live and retries with growing backoff", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().emit("error");
  assert.equal(s.source().closed, true);
  assert.deepEqual(chart.states, ["connecting", "reconnecting"]);
  s.fire(500);
  assert.equal(s.sources.length, 2);
  s.source().emit("error");
  s.fire(1_000);
  assert.equal(s.sources.length, 3);
  assert.equal(chart.states.includes("live"), false);
  s.source().fence(10);
  s.source().hello();
  assert.equal(chart.states.at(-1), "live");
  s.source().emit("error");
  assert.ok(s.timers.some((timer) => timer.ms === 2_000), "a moment of live does not reset the backoff");
  s.fire(2_000);
  s.source().fence(10);
  s.source().hello();
  s.fire(STABLE_MS);
  s.source().emit("error");
  assert.ok(s.timers.some((timer) => timer.ms === 500), "a connection that stayed live resets the backoff");
});

test("a subscriber's restart drops the stream once and reconnects with backoff", async () => {
  const s = setup();
  const chart = watcher();
  const subscription = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().fence(10);
  s.source().hello();
  subscription.restart();
  subscription.restart();
  assert.equal(s.sources.length, 1);
  assert.equal(s.timers.filter((timer) => timer.ms === 500).length, 1);
  s.fire(500);
  s.source().fence(10);
  s.source().hello();
  subscription.restart(); // a chart whose history keeps overflowing its buffer
  assert.ok(s.timers.some((timer) => timer.ms === 1_000), "repeated restarts of a live stream back off");
  subscription.stop();
  await settle();
  assert.equal(s.timers.length, 0);
});

function legacy() {
  let opened = 0;
  const create = () => { opened++; return { send: () => {}, close: () => {}, onmessage: null, onclose: null }; };
  return { create, opened: () => opened };
}

test("hint clients wait for the market hello across a pool change and a long hide, without the legacy stream", async () => {
  const s = setup();
  const fallback = legacy();
  const chart = watcher();
  const first = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const hints = marketHintTransport("/hints", fallback.create);
  const frames: string[] = [];
  hints.onmessage = ({ data }) => frames.push(String(data));
  first.stop();
  s.hub.subscribe({ pools: [OTHER], expected, listener: watcher([OTHER]).listener });
  await settle();
  assert.equal(fallback.opened(), 0, "a pool change before the hello keeps waiting");
  s.source().fence(10, OTHER);
  s.source().hello();
  assert.equal(frames.length, 1);
  let disconnected = 0;
  hints.onclose = () => { disconnected++; };
  s.setVisible(false);
  s.fire(HIDDEN_GRACE_MS);
  assert.equal(disconnected, 1, "the paused stream's hint clients reconnect and catch up");
  const returning = marketHintTransport("/hints", fallback.create);
  await settle();
  s.setVisible(true);
  s.source().fence(12, OTHER);
  s.source().hello();
  assert.equal(fallback.opened(), 0, "a tab shown again waits for the new hello");
  returning.close();
});

test("a coin observer follows the stream's trades without opening or widening it", async () => {
  const s = setup();
  const coinType = `0x${"44".repeat(32)}::meme::MEME`;
  const live: boolean[] = [];
  const seen: MarketTrade[] = [];
  const stop = s.hub.observe(coinType, { live: (value) => live.push(value), trade: (value) => seen.push(value) });
  await settle();
  assert.equal(s.sources.length, 0, "observing alone opens nothing");
  assert.deepEqual(live, [false]);
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, coin: coinType, listener: chart.listener });
  s.source().fence(10);
  s.source().hello();
  assert.deepEqual(live, [false, true]);
  assert.deepEqual(s.source().pools(), [CURVE]);
  s.source().emit("market", trade(11));
  assert.deepEqual(seen.map((each) => each.checkpoint), [11]);
  s.setVisible(false);
  s.fire(HIDDEN_GRACE_MS);
  assert.deepEqual(live, [false, true, false]);
  stop();
  s.setVisible(true);
  s.source().fence(12);
  s.source().hello();
  s.source().emit("market", trade(13));
  assert.deepEqual(live, [false, true, false]);
  assert.equal(seen.length, 1);
});

test("a pool whose subscriber names no coin learns it from its first trade's summary", async () => {
  const s = setup();
  const coinType = `0x${"44".repeat(32)}::meme::MEME`;
  const other = `0x${"55".repeat(32)}::meme::MEME`;
  const live: boolean[] = [];
  const seen: MarketTrade[] = [];
  const otherSeen: MarketTrade[] = [];
  s.hub.observe(coinType, { live: (value) => live.push(value), trade: (value) => seen.push(value) });
  s.hub.observe(other, { live: () => {}, trade: (value) => otherSeen.push(value) });
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().fence(10);
  s.source().hello();
  assert.deepEqual(live, [false]);
  s.source().emit("market", trade(11, 2, { coin: coinType, holders: 3 }));
  assert.deepEqual(live, [false, true]);
  assert.deepEqual(seen.map((each) => each.checkpoint), [11]);
  assert.equal(otherSeen.length, 0);
});

// This fails if coin stats reach a screen for a pool it did not ask for, before the pool's fence, or from another deployment.
test("coin stats reach only the fenced pool's subscribers from the expected deployment", async () => {
  const s = setup();
  const curve: unknown[] = [];
  const other: unknown[] = [];
  s.hub.subscribe({ pools: [CURVE], expected, listener: { state: () => {}, stats: (frame) => curve.push(frame.holders) } });
  s.hub.subscribe({ pools: [VENUE], expected, listener: { state: () => {}, stats: (frame) => other.push(frame.holders) } });
  await settle();
  const stats = (holders: number, deployment = DEPLOYMENT) => ({
    type: "coin_stats", coin: `0x${"44".repeat(32)}::meme::MEME`, pool_key: CURVE, checkpoint: 20, timestamp_ms: NOW + 20,
    cursor: "20:0:0:0", provenance: { ...wireProvenance(20), deployment_fingerprint: deployment }, holders, price: "0.5",
  });
  s.source().emit("stats", stats(1));
  assert.deepEqual(curve, [], "no stats before the pool's fence");
  s.source().fence(10);
  s.source().fence(10, VENUE);
  s.source().hello();
  s.source().emit("stats", stats(2));
  s.source().emit("stats", stats(3, "cd".repeat(32)));
  s.source().emit("stats", { ...stats(4), holders: -1 });
  assert.deepEqual(curve, [2]);
  assert.deepEqual(other, []);
});

// This fails if a migrated coin's frozen curve stats replace its venue stats, or a late screen waits for the next change.
test("a coin's newest stats win across its two pools, and a late subscriber gets them at once", async () => {
  const s = setup();
  const first: unknown[] = [];
  s.hub.subscribe({ pools: [CURVE, VENUE], expected, listener: { state: () => {}, stats: (frame) => first.push(frame.holders) } });
  await settle();
  const stats = (pool: string, checkpoint: number, holders: number) => ({
    type: "coin_stats", coin: `0x${"44".repeat(32)}::meme::MEME`, pool_key: pool, checkpoint, timestamp_ms: NOW + checkpoint,
    cursor: `${checkpoint}:0:0:0`, provenance: wireProvenance(checkpoint), holders, price: "0.5",
  });
  s.source().fence(10);
  s.source().fence(10, VENUE);
  s.source().hello();
  s.source().emit("stats", stats(VENUE, 30, 250));
  s.source().emit("stats", stats(CURVE, 20, 211));
  s.source().emit("stats", { ...stats(CURVE, 30, 212), cursor: "29:9:0:0" });
  assert.deepEqual(first, [250], "the curve's older stats are dropped, by checkpoint and then by cursor");
  const late: unknown[] = [];
  s.hub.subscribe({ pools: [CURVE, VENUE], expected, listener: { state: () => {}, stats: (frame) => late.push(frame.holders) } });
  await settle();
  assert.deepEqual(late, [250]);
});
