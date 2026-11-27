import assert from "node:assert/strict";
import test from "node:test";

import { MARKET_STREAM_BUDGET } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { marketHintTransport } from "#web/lib/live-stream/market-hints.ts";
import { HIDDEN_GRACE_MS, LINGER_MS, MarketStreamHub, SET_ANSWER_MS, STABLE_MS, type MarketEventSource, type MarketStreamState, type MarketTrade } from "./market-stream-hub.ts";

const CURVE = `blast_curve:0x${"11".repeat(32)}`;
const VENUE = `cetus:0x${"22".repeat(32)}`;
const OTHER = `blast_curve:0x${"33".repeat(32)}`;
const DEPLOYMENT = "ab".repeat(32);
const NOW = 1_790_000_000_000;
const expected = { network: "mainnet" as const, deployment: DEPLOYMENT };
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const wireProvenance = (checkpoint: number) => ({ network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: NOW + checkpoint, observed_ms: NOW + checkpoint + 20, lag_ms: 20, hops: { arrived_ms: NOW + checkpoint + 5, r2_put_ms: 38, written_ms: NOW + checkpoint + 15, picked_ms: NOW + checkpoint + 20 } });

function trade(checkpoint: number, part = 2, summary: unknown = { holders: checkpoint }) {
  return { type: "trade", cursor: `${checkpoint}:1:0:${part}`, checkpoint, timestamp_ms: NOW + checkpoint, provenance: wireProvenance(checkpoint), summary, trade: { cursor: `${checkpoint}:1:0:${part}`, timestamp_ms: NOW + checkpoint, digest: "1".repeat(32), pool_key: CURVE, venue: "blast_curve", trader: null, side: "buy", kind: "buy", quote_amount: "5", meme_amount: "3", price: "2", volume_usd: null, venue_swap: null } };
}

type SetFrame = { op: "set"; seq: number; pools: string[]; price_coins: string[]; presale: string | null };

class Source implements MarketEventSource {
  closed = false;
  /** The hub gave up at a deadline: the source counts it as a failure. */
  failed = false;
  readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close(failed?: boolean): void { this.closed = true; this.failed = failed === true; }
  send(text: string): boolean { if (this.closed) return false; this.sent.push(text); return true; }
  emit(type: string, value: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(value) }); }
  fence(checkpoint: number, poolKey = CURVE): void { this.emit("status", { state: "live", pool_key: poolKey, checkpoint, cursor: `${checkpoint}:0:0:0`, provenance: wireProvenance(checkpoint) }); }
  /** `set`: this relay changes topics by message (every relay since the set protocol). */
  hello(heartbeat = false, set = true): void { this.emit("hint", { type: "hello", provenance: wireProvenance(1), heartbeat, ...(set ? { set: true } : {}) }); }
  pools(): string[] { return new URL(this.url, "https://blast.test").searchParams.getAll("pool"); }
  sets(): SetFrame[] { return this.sent.map((text) => JSON.parse(text) as SetFrame); }
  /** Answers the last `set` as the relay does: `held` is what the socket now holds. */
  answer(refusal?: Readonly<{ reason: string; retry_ms: number; held: Readonly<{ pools: string[]; price_coins: string[]; presale: string | null }> }>): void {
    const { seq, pools, price_coins, presale } = this.sets().at(-1)!;
    this.emit("set", refusal ? { seq, ok: false, reason: refusal.reason, retry_ms: refusal.retry_ms, held: refusal.held } : { seq, ok: true, held: { pools, price_coins, presale } });
  }
}

function setup() {
  const sources: Source[] = [];
  const timers: { run: () => void; ms: number; at: number }[] = [];
  let now = 0;
  let visible = true;
  let onVisibility: (() => void) | null = null;
  const schedule = (run: () => void, ms: number) => { const timer = { run, ms, at: now + ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; };
  const hub = new MarketStreamHub({
    createSource: (url) => { const source = new Source(url); sources.push(source); return source; },
    schedule,
    defer: queueMicrotask, random: () => 0, visible: () => visible,
    onVisibilityChange: (listener) => { onVisibility = listener; return () => { onVisibility = null; }; },
  });
  const fire = (ms: number) => { const timer = timers.find((entry) => entry.ms === ms)!; assert.ok(timer, `a ${ms} ms timer is pending`); timers.splice(timers.indexOf(timer), 1); timer.run(); };
  /** Moves the fake clock on, running each timer that falls due, in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.at;
      due.run();
    }
    now = end;
  };
  const setVisible = (value: boolean) => { visible = value; onVisibility?.(); };
  return { hub, sources, timers, fire, advance, setVisible, source: () => sources.at(-1)!, listening: () => onVisibility !== null };
}

function watcher(pools: string[] = [CURVE]) {
  const states: MarketStreamState[] = [];
  const poolStates: [string, MarketStreamState][] = [];
  const fences: [string, number][] = [];
  const trades: MarketTrade[] = [];
  const last = (pool: string) => poolStates.filter(([key]) => key === pool).at(-1)?.[1];
  return {
    pools, states, poolStates, fences, trades, last,
    listener: {
      state: (state: MarketStreamState) => states.push(state),
      pool: (pool: string, state: MarketStreamState) => poolStates.push([pool, state]),
      fence: (pool: string, checkpoint: number) => fences.push([pool, checkpoint]),
      trade: (value: MarketTrade) => trades.push(value),
    },
  };
}

/** A venue trade frame for `pool`. */
function poolTrade(pool: string, checkpoint: number, part = 2) {
  const frame = trade(checkpoint, part);
  return { ...frame, trade: { ...frame.trade, pool_key: pool, venue: pool.split(":")[0], kind: pool.startsWith("blast_curve") ? "buy" : "swap" } };
}

/** A hello from a relay that sends heartbeats every 4 s. */
function heartbeatHello(source: Source) {
  source.emit("hint", { type: "hello", provenance: wireProvenance(1), heartbeat: true, heartbeat_ms: MARKET_STREAM_BUDGET.heartbeatMs });
}

const settle = () => Promise.resolve();

test("two subscribers to the same pool share one source, and it closes after the last leaves", async () => {
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
  assert.equal(s.source().closed, false, "the socket lingers for the next page's screens");
  s.advance(LINGER_MS);
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
  assert.equal(old.failed, true, "a missed heartbeat counts as a failure");
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
  s.advance(LINGER_MS);
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

test("a pool set change sends one set on the same socket and never opens a second stream", async () => {
  const s = setup();
  const coin = watcher();
  const first = s.hub.subscribe({ pools: coin.pools, expected, listener: coin.listener });
  s.source().fence(10);
  s.source().hello();
  const next = watcher([OTHER]);
  first.stop();
  s.hub.subscribe({ pools: next.pools, expected, listener: next.listener });
  await settle();
  assert.equal(s.sources.length, 1);
  assert.deepEqual(s.source().sets().map(({ pools }) => pools), [[OTHER]]);
  assert.deepEqual(next.states, ["connecting"], "the new pool waits for the answer and its fence");
  s.source().answer();
  s.source().fence(12, OTHER);
  assert.equal(next.states.at(-1), "live");
  assert.deepEqual(next.fences, [[OTHER, 12]]);
  assert.equal(coin.states.at(-1), "live", "a stopped subscriber hears nothing more");
});

test("a third pool beyond the two-pool budget is over budget, the rest is served, and it clears when a slot frees", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const other = watcher([OTHER]);
  const newest = s.hub.subscribe({ pools: other.pools, expected, listener: other.listener });
  await settle();
  s.source().hello();
  assert.deepEqual(s.source().sets().at(-1)?.pools, [OTHER, CURVE], "the newest screen first, then what fits of the older one");
  s.source().answer();
  s.source().fence(10, OTHER);
  s.source().fence(10);
  assert.equal(chart.last(CURVE), "live");
  assert.equal(chart.last(VENUE), "over_budget");
  assert.equal(chart.states.at(-1), "over_budget");
  assert.equal(other.states.at(-1), "live");
  newest.stop();
  await settle();
  assert.deepEqual(s.source().sets().at(-1)?.pools, [CURVE, VENUE], "the freed slot goes to the waiting pool");
  s.source().answer();
  s.source().fence(11, VENUE);
  assert.equal(chart.last(VENUE), "live");
  assert.equal(chart.states.at(-1), "live");
  assert.deepEqual(chart.fences, [[CURVE, 10], [VENUE, 11]], "the kept pool keeps its fence");
  assert.equal(s.sources.length, 1);
});

// This fails if one pool the reader never answers (or does not know) ends the socket, marks the
// other pool unavailable, or keeps a retry loop running.
test("a pool the relay never fences waits on its own; the socket and the other pool stream on", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  const subscription = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  heartbeatHello(s.source());
  s.source().fence(10);
  for (let second = 0; second < 600; second += 4) {
    s.source().emit("heartbeat");
    s.advance(4_000);
  }
  assert.equal(s.sources.length, 1, "no reconnect in ten minutes");
  assert.equal(s.source().closed, false);
  assert.equal(chart.last(CURVE), "live");
  assert.equal(chart.last(VENUE), "connecting");
  assert.equal(subscription.ready(CURVE), true);
  assert.equal(subscription.ready(VENUE), false);
  assert.equal(subscription.state(VENUE), "connecting");
  assert.equal(subscription.state(OTHER), "over_budget", "a pool it never asked for");
  assert.equal(chart.states.includes("unavailable"), false);
});

test("not_found: the relay names one pool unavailable, keeps the socket, and may fence it later", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().emit("status", { state: "unavailable", pool_key: VENUE });
  assert.equal(chart.last(VENUE), "unavailable");
  assert.equal(chart.last(CURVE), "live");
  assert.equal(s.source().closed, false);
  assert.equal(s.timers.some((timer) => timer.ms > 30_000), false, "no slow retry of the hub's own");
  s.source().emit("market", poolTrade(CURVE, 11));
  assert.equal(chart.trades.length, 1);
  s.source().fence(70, VENUE); // The relay asked again a minute later, and the reader knows it now.
  assert.equal(chart.last(VENUE), "live");
  assert.equal(chart.states.at(-1), "live");
  assert.equal(s.sources.length, 1);
});

test("before the hello, a pool-named unavailable marks that pool alone; the hello deadline still guards the socket", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().emit("status", { state: "unavailable", pool_key: CURVE });
  assert.deepEqual(chart.states, ["connecting"]);
  s.source().hello();
  assert.equal(chart.states.at(-1), "unavailable");
  assert.equal(s.timers.some((timer) => timer.ms === 10_000), false, "the handshake deadline is gone after the hello");
});

test("quiet pools stay live for ten minutes on heartbeats alone", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  heartbeatHello(s.source());
  s.source().fence(10);
  s.source().fence(10, VENUE);
  for (let second = 0; second < 600; second += 4) {
    s.source().emit("heartbeat");
    s.advance(4_000);
  }
  assert.equal(s.sources.length, 1);
  assert.deepEqual(chart.states, ["connecting", "live"]);
  assert.deepEqual(chart.fences, [[CURVE, 10], [VENUE, 10]], "no fence again");
});

test("a busy pool and a quiet pool: every trade of the busy one arrives once and the quiet one stays live", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  heartbeatHello(s.source());
  s.source().fence(10);
  s.source().fence(10, VENUE);
  for (let checkpoint = 11; checkpoint < 311; checkpoint++) {
    s.source().emit("market", poolTrade(CURVE, checkpoint));
    s.source().emit("heartbeat");
    s.advance(1_000);
  }
  assert.equal(chart.trades.length, 300);
  assert.equal(chart.last(VENUE), "live");
  assert.equal(s.sources.length, 1);
});

// This fails if an upstream loss on the relay drops fences, closes the socket, or never comes back live.
test("an upstream drop makes fenced pools stale, keeps the socket, and fresh or a new fence brings them back", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  const subscription = s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  heartbeatHello(s.source());
  s.source().fence(10);
  s.source().fence(10, VENUE);
  for (let second = 0; second < 600; second += 4) { // A long quiet spell first, on heartbeats.
    s.source().emit("heartbeat");
    s.advance(4_000);
  }
  s.source().emit("status", { state: "recovering" });
  assert.equal(chart.last(CURVE), "stale");
  assert.equal(chart.last(VENUE), "stale");
  assert.equal(subscription.ready(CURVE), false, "a stale pool polls");
  s.source().emit("heartbeat"); // The relay keeps heartbeats for 30 s.
  s.source().fence(20); // Resumed with a snapshot: a new fence for that pool.
  s.source().emit("status", { state: "fresh" });
  assert.equal(chart.last(CURVE), "live");
  assert.equal(chart.last(VENUE), "live", "a pool resumed by cursor keeps its fence");
  assert.deepEqual(chart.fences, [[CURVE, 10], [VENUE, 10], [CURVE, 20]]);
  assert.equal(s.sources.length, 1);
  assert.equal(s.source().closed, false);
});

test("stale, then recovery: a lagging relay marks pools stale while frames keep flowing", async () => {
  const s = setup();
  const chart = watcher([CURVE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().emit("status", { state: "stale" });
  assert.equal(chart.states.at(-1), "stale");
  s.source().emit("market", trade(11));
  assert.equal(chart.trades.length, 1);
  s.source().emit("status", { state: "fresh" });
  assert.equal(chart.states.at(-1), "live");
  assert.deepEqual(chart.fences, [[CURVE, 10]]);
});

test("a pool the relay re-fences is recovering while the other pool streams", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().fence(10, VENUE);
  s.source().emit("status", { state: "recovering", pool_key: VENUE });
  assert.equal(chart.last(VENUE), "recovering");
  s.source().emit("market", poolTrade(VENUE, 11));
  s.source().emit("market", poolTrade(CURVE, 11));
  assert.deepEqual(chart.trades.map(({ poolKey }) => poolKey), [CURVE], "a frame for an unfenced pool is dropped");
  s.source().fence(12, VENUE);
  assert.equal(chart.last(VENUE), "live");
  assert.equal(s.sources.length, 1);
});

test("an oversized or bad frame re-fences only its pool, on the same socket", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().fence(10, VENUE);
  s.source().emit("market", { ...poolTrade(CURVE, 15), padding: "x".repeat(MARKET_STREAM_BUDGET.maxUpstreamFrameChars) });
  assert.deepEqual(chart.fences.at(-1), [CURVE, 15], "the pool reads history through the lost frame");
  s.source().emit("market", { ...poolTrade(VENUE, 16), trade: { ...poolTrade(VENUE, 16).trade, side: "sideways" } });
  assert.deepEqual(chart.fences.at(-1), [VENUE, 16]);
  s.source().emit("market", poolTrade(CURVE, 17));
  assert.equal(chart.trades.length, 1, "frames after the new fence still stream");
  assert.equal(s.sources.length, 1);
  assert.equal(s.source().closed, false);
  assert.equal(chart.last(CURVE), "live");
  s.source().listeners.get("market")![0]!({ data: "{not json" });
  assert.equal(s.source().closed, false, "a frame no pool can be blamed for re-fences, never reconnects");
});

test("repeated bad frames on one pool back off its local re-fences (0, 5, 10, 30 s) and reset once a fence holds a minute", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().fence(10, VENUE);
  const bad = (checkpoint: number) => s.source().emit("market", { ...poolTrade(CURVE, checkpoint), trade: { ...poolTrade(CURVE, checkpoint).trade, side: "sideways" } });
  const curveFences = () => chart.fences.filter(([pool]) => pool === CURVE).length;
  bad(11);
  assert.equal(curveFences(), 2, "the first re-fence is at once");
  bad(12);
  assert.equal(curveFences(), 2);
  assert.equal(chart.last(CURVE), "recovering", "while it waits the pool polls");
  assert.equal(chart.last(VENUE), "live");
  bad(13); // frames while it waits are dropped, not re-fenced again
  s.source().emit("market", poolTrade(CURVE, 14));
  assert.equal(chart.trades.length, 0);
  s.advance(5_000);
  assert.deepEqual(chart.fences.at(-1), [CURVE, 14]);
  assert.equal(chart.last(CURVE), "live");
  bad(15);
  s.advance(9_999);
  assert.equal(curveFences(), 3);
  s.advance(1);
  assert.equal(curveFences(), 4);
  s.advance(60_000); // the fence held: the count resets
  bad(16);
  assert.equal(curveFences(), 5, "at once again");
  assert.equal(s.sources.length, 1);
});

test("a candle interval no chart reads (1s) is skipped, not a bad frame", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, migration: () => null, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().emit("market", { type: "candle_closed", pool_key: CURVE, cursor: "11:1:0:2", checkpoint: 11, timestamp_ms: NOW + 11, provenance: wireProvenance(11), interval: "1s", candle: {} });
  assert.deepEqual(chart.fences, [[CURVE, 10]]);
  s.source().emit("market", trade(12));
  assert.equal(chart.trades.length, 1);
});

test("a listener that throws harms only itself", async () => {
  const s = setup();
  const good = watcher();
  s.hub.subscribe({ pools: [CURVE], expected, listener: { state: () => { throw new Error("state"); }, fence: () => { throw new Error("fence"); }, trade: () => { throw new Error("trade"); } } });
  s.hub.subscribe({ pools: good.pools, expected, listener: good.listener });
  await settle();
  s.source().hello();
  s.source().fence(10);
  s.source().emit("market", trade(11));
  assert.deepEqual(good.fences, [[CURVE, 10]]);
  assert.equal(good.trades.length, 1);
  assert.equal(good.states.at(-1), "live");
  assert.equal(s.sources.length, 1);
  assert.equal(s.source().closed, false);
});

test("heartbeat silence over 9 s reconnects with backoff and fences again", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  heartbeatHello(s.source());
  s.source().fence(10);
  s.advance(MARKET_STREAM_BUDGET.heartbeatTimeoutMs);
  assert.equal(s.sources[0].closed, true);
  assert.equal(s.sources[0].failed, true);
  assert.equal(chart.states.at(-1), "reconnecting");
  s.advance(500);
  assert.equal(s.sources.length, 2);
  s.source().hello();
  s.source().fence(12);
  assert.equal(chart.states.at(-1), "live");
});

test("socket rotation: the relay closes, the hub reconnects at once with a short backoff and fences each pool again", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().fence(10, VENUE);
  s.advance(45 * 60_000);
  s.source().emit("error");
  assert.equal(chart.states.at(-1), "reconnecting");
  s.advance(500);
  s.source().hello();
  s.source().fence(30);
  s.source().fence(30, VENUE);
  assert.equal(chart.states.at(-1), "live");
  assert.deepEqual(chart.fences.slice(2), [[CURVE, 30], [VENUE, 30]]);
  assert.equal(chart.states.includes("unavailable"), false);
});

test("the backoff runs 500 ms doubling up to 30 s", async () => {
  const s = setup();
  s.hub.subscribe({ pools: [CURVE], expected, listener: watcher().listener });
  const waits: number[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    s.source().emit("error");
    const wait = s.timers.find((timer) => timer.ms !== 10_000)!.ms;
    waits.push(wait);
    s.advance(wait);
  }
  assert.deepEqual(waits, [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("a tab hidden over 15 s pauses; shown during a backoff it reconnects at once", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  for (let attempt = 0; attempt < 5; attempt++) {
    s.source().emit("error");
    s.advance(s.timers.find((timer) => timer.ms !== 10_000)!.ms);
  }
  s.source().emit("error");
  assert.ok(s.timers.some((timer) => timer.ms === 16_000), "a long backoff is pending");
  s.setVisible(false);
  s.advance(HIDDEN_GRACE_MS + 1_000);
  assert.equal(chart.states.at(-1), "paused", "the backoff ends in a hidden tab: it pauses");
  const opened = s.sources.length;
  s.setVisible(true);
  assert.equal(s.sources.length, opened + 1, "shown again: at once");
  s.source().emit("error");
  s.setVisible(false);
  s.setVisible(true);
  assert.equal(s.sources.length, opened + 2, "shown during a backoff: at once, the backoff cancelled");
  assert.equal(s.timers.some((timer) => timer.ms >= 500 && timer.ms !== 10_000), false);
});

// This fails if the new hub cannot live with the relay already deployed: it sends only live and
// unavailable, ends the socket after a stalled pool, and sends resync.
test("the old relay: a pool's unavailable then close waits a minute before reopening, and resync ends the socket", async () => {
  const s = setup();
  const chart = watcher([CURVE, VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.source().emit("status", { state: "unavailable", pool_key: VENUE });
  s.source().emit("error"); // The old relay stops the client after a stall.
  assert.equal(chart.states.at(-1), "reconnecting");
  s.advance(30_000);
  assert.equal(s.sources.length, 1, "no quick reopen loop against an old relay");
  s.advance(30_000);
  assert.equal(s.sources.length, 2);
  s.source().hello();
  s.source().fence(11);
  assert.equal(chart.last(CURVE), "live");
  s.source().emit("resync", { state: "resync", pool_key: CURVE });
  assert.equal(s.source().closed, true);
  assert.equal(chart.states.at(-1), "reconnecting");
  s.advance(1_000);
  assert.equal(s.sources.length, 3);
});

test("without the hint handshake the deadline reconnects with backoff, as an upstream fault", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().fence(10);
  s.fire(10_000);
  assert.equal(s.source().failed, true, "a missed hello counts as a failure");
  assert.deepEqual(chart.states, ["connecting", "reconnecting"]);
  s.fire(500);
  assert.equal(s.sources.length, 2);
});

test("a dropped stream is not live and retries with growing backoff", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().emit("error");
  assert.equal(s.source().closed, true);
  assert.equal(s.source().failed, false, "the source already counted its own close");
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

// This fails if a refused tab loops on the socket, never retries it, or leaves
// a subscriber thinking it is live (its polls stop) during the wait.
test("a refused stream is unavailable for the wait it names, then the socket is tried again", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().listeners.get("refused")![0]!({ data: "60000" });
  assert.equal(s.source().closed, true);
  assert.deepEqual(chart.states, ["connecting", "unavailable"]);
  assert.deepEqual(s.timers.map(({ ms }) => ms), [60_000], "one retry, at the end of the wait");
  const late = watcher();
  s.hub.subscribe({ pools: late.pools, expected, listener: late.listener });
  await settle();
  assert.deepEqual(late.states, ["unavailable"], "a later subscriber to the same pools is told the truth");
  s.fire(60_000);
  assert.equal(s.sources.length, 2, "the socket is tried again after the wait");
  assert.equal(chart.states.at(-1), "connecting");
  s.source().fence(10);
  s.source().hello();
  assert.equal(chart.states.at(-1), "live");
  s.source().listeners.get("refused")![0]!({ data: "60000" });
  s.setVisible(false);
  s.setVisible(true);
  assert.equal(s.sources.length, 3, "a tab shown again asks the source at once (it answers at once while the wait lasts)");
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
  const hints = marketHintTransport("/hints", fallback.create, queueMicrotask);
  const frames: string[] = [];
  hints.onmessage = ({ data }) => frames.push(String(data));
  first.stop();
  s.hub.subscribe({ pools: [OTHER], expected, listener: watcher([OTHER]).listener });
  await settle();
  assert.equal(fallback.opened(), 0, "a pool change before the hello keeps waiting");
  s.source().hello();
  assert.equal(frames.length, 1);
  s.source().answer();
  s.source().fence(10, OTHER);
  let disconnected = 0;
  hints.onclose = () => { disconnected++; };
  s.setVisible(false);
  s.fire(HIDDEN_GRACE_MS);
  assert.equal(disconnected, 1, "the paused stream's hint clients reconnect and catch up");
  const returning = marketHintTransport("/hints", fallback.create, queueMicrotask);
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
  // `live` is a level, told on every pool state change: the test keeps its changes.
  const stop = s.hub.observe(coinType, { live: (value) => { if (live.at(-1) !== value) live.push(value); }, trade: (value) => seen.push(value) });
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


// The set protocol: one socket per tab; a page changes its topics with one `set` message.

test("a second screen adds its pool with one set on the same socket", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  const venue = watcher([VENUE]);
  s.hub.subscribe({ pools: venue.pools, expected, listener: venue.listener });
  await settle();
  assert.equal(s.sources.length, 1, "createSource once");
  assert.deepEqual(s.source().sets(), [{ op: "set", seq: 1, pools: [VENUE, CURVE], price_coins: [], presale: null }]);
  s.source().answer();
  s.source().fence(11, VENUE);
  assert.equal(venue.states.at(-1), "live");
  assert.deepEqual(chart.fences, [[CURVE, 10]], "the kept pool is not fenced again");
});

test("a screen that stops sends one set without its pool; the other pool keeps its fence", async () => {
  const s = setup();
  const chart = watcher();
  const venue = watcher([VENUE]);
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  const leaving = s.hub.subscribe({ pools: venue.pools, expected, listener: venue.listener });
  await settle();
  s.source().hello();
  s.source().answer();
  s.source().fence(10);
  s.source().fence(10, VENUE);
  leaving.stop();
  await settle();
  assert.deepEqual(s.source().sets().map(({ pools }) => pools), [[VENUE, CURVE], [CURVE]]);
  s.source().answer();
  s.source().emit("market", trade(11));
  assert.equal(chart.trades.length, 1);
  assert.equal(chart.states.at(-1), "live");
  assert.deepEqual(chart.fences, [[CURVE, 10]]);
  assert.equal(s.sources.length, 1);
});

test("coin A to coin B with nothing wanted between keeps one socket and sends one set", async () => {
  const s = setup();
  const a = watcher();
  const first = s.hub.subscribe({ pools: a.pools, expected, listener: a.listener });
  s.source().hello();
  s.source().fence(10);
  first.stop();
  await settle();
  s.advance(LINGER_MS - 1);
  assert.equal(s.source().closed, false, "nothing wanted: the socket lingers");
  assert.equal(s.source().sent.length, 0, "and sends nothing while it waits");
  const b = watcher([OTHER]);
  s.hub.subscribe({ pools: b.pools, expected, listener: b.listener });
  await settle();
  s.advance(LINGER_MS);
  assert.equal(s.sources.length, 1);
  assert.equal(s.source().closed, false);
  assert.deepEqual(s.source().sets().map(({ pools }) => pools), [[OTHER]]);
  s.source().answer();
  s.source().fence(12, OTHER);
  assert.equal(b.states.at(-1), "live");
});

test("changes while a set is in flight go out as one set with the latest topics after the answer", async () => {
  const s = setup();
  const a = watcher();
  const first = s.hub.subscribe({ pools: a.pools, expected, listener: a.listener });
  s.source().hello();
  s.source().fence(10);
  first.stop();
  const b = s.hub.subscribe({ pools: [OTHER], expected, listener: watcher([OTHER]).listener });
  await settle();
  assert.equal(s.source().sets().length, 1, "A to B is in flight");
  b.stop();
  const back = watcher();
  const again = s.hub.subscribe({ pools: back.pools, expected, listener: back.listener }); // B to A
  await settle();
  again.stop();
  s.hub.subscribe({ pools: [VENUE], expected, listener: watcher([VENUE]).listener }); // A to venue
  await settle();
  const latest = watcher();
  s.hub.subscribe({ pools: latest.pools, expected, listener: latest.listener }); // and A again
  await settle();
  assert.equal(s.source().sets().length, 1, "one set in flight at a time");
  s.source().answer();
  assert.deepEqual(s.source().sets().map(({ seq, pools }) => [seq, pools]), [[1, [OTHER]], [2, [CURVE, VENUE]]]);
  s.source().answer();
  s.source().fence(20);
  s.source().fence(20, VENUE);
  assert.equal(latest.states.at(-1), "live");
  assert.equal(s.source().sets().length, 2);
  assert.equal(s.sources.length, 1);
});

test("changes before the hello go out as one set after it", async () => {
  const s = setup();
  const a = watcher();
  const first = s.hub.subscribe({ pools: a.pools, expected, listener: a.listener });
  first.stop();
  s.hub.subscribe({ pools: [OTHER], expected, listener: watcher([OTHER]).listener });
  await settle();
  s.hub.subscribe({ pools: [], priceCoins: [SUI], expected: null, listener: watcher([]).listener });
  await settle();
  assert.equal(s.source().sent.length, 0, "no set before the hello");
  s.source().hello();
  assert.deepEqual(s.source().sets(), [{ op: "set", seq: 1, pools: [OTHER], price_coins: [SUI], presale: null }]);
  assert.equal(s.sources.length, 1);
});

test("a refused set marks only the added pools unavailable, keeps the old ones live, and retries after retry_ms", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  const venue = watcher([VENUE]);
  s.hub.subscribe({ pools: venue.pools, expected, listener: venue.listener });
  await settle();
  s.source().answer({ reason: "churn", retry_ms: 20_000, held: { pools: [CURVE], price_coins: [], presale: null } });
  assert.equal(venue.states.at(-1), "unavailable");
  assert.equal(chart.states.at(-1), "live");
  s.source().emit("market", trade(11));
  assert.equal(chart.trades.length, 1);
  s.advance(19_999);
  assert.equal(s.source().sets().length, 1);
  s.advance(1);
  assert.deepEqual(s.source().sets().map(({ seq, pools }) => [seq, pools]), [[1, [VENUE, CURVE]], [2, [VENUE, CURVE]]]);
  s.source().answer();
  s.source().fence(30, VENUE);
  assert.equal(venue.states.at(-1), "live");
  assert.equal(s.sources.length, 1);
});

// This fails if a pool left while its own `set` is in flight ignores the fence that follows the answer:
// after a refused `set` that leaves it held, a screen that wants it back would wait forever.
test("a pool left while its set is in flight keeps the fence after the answer; wanted back after a refused set, it is live", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  const left = s.hub.subscribe({ pools: [VENUE], expected, listener: watcher([VENUE]).listener });
  await settle();
  left.stop();
  await settle();
  const held = s.source().sets().at(-1)!.pools;
  s.source().answer();
  s.source().fence(20, VENUE); // the catch-up that follows the answer
  assert.deepEqual(s.source().sets().at(-1)!.pools, [CURVE]);
  s.source().answer({ reason: "rate", retry_ms: 1_000, held: { pools: held, price_coins: [], presale: null } });
  const back = watcher([VENUE]);
  s.hub.subscribe({ pools: back.pools, expected, listener: back.listener });
  await settle();
  s.advance(1_500);
  assert.deepEqual(back.fences, [[VENUE, 20]]);
  assert.equal(back.last(VENUE), "live");
  assert.equal(s.sources.length, 1);
});

// This fails if the pong for a presale left while its `set` is in flight is lost: it would come back never ready.
test("a presale left while its set is in flight keeps its pong; wanted back after a refused set, it is ready", async () => {
  const s = setup();
  s.hub.subscribe({ pools: [CURVE], expected, listener: watcher().listener });
  s.source().hello();
  s.source().fence(10);
  const sale = `0x${"66".repeat(32)}`;
  const left = s.hub.subscribe({ pools: [], presale: sale, expected: null, listener: { state: () => {} } });
  await settle();
  left.stop();
  await settle();
  s.source().answer();
  s.source().emit("hint", { type: "pong", presale_checkpoint: 40 });
  assert.equal(s.source().sets().at(-1)!.presale, null);
  s.source().answer({ reason: "rate", retry_ms: 1_000, held: { pools: [CURVE], price_coins: [], presale: sale } });
  const ready: (number | null)[] = [];
  s.hub.subscribe({ pools: [], presale: sale, expected: null, listener: { state: () => {}, presaleReady: (checkpoint) => ready.push(checkpoint) } });
  await settle();
  s.advance(1_500);
  assert.equal(ready.at(-1), 40);
  assert.equal(s.sources.length, 1);
});

// This fails if a pool fenced under one deployment comes back with that fence after the tab moved to another.
test("a pool fenced under another deployment never comes back with its old fence: wanted again, it opens a new socket", async () => {
  const s = setup();
  const first = s.hub.subscribe({ pools: [CURVE], expected: null, listener: watcher().listener });
  s.source().hello();
  s.source().fence(10);
  first.stop();
  s.hub.subscribe({ pools: [OTHER], expected, listener: watcher([OTHER]).listener });
  await settle();
  assert.deepEqual(s.source().sets().map(({ pools }) => pools), [[OTHER]]);
  const back = watcher();
  s.hub.subscribe({ pools: back.pools, expected, listener: back.listener });
  await settle();
  assert.deepEqual(back.fences, [], "the old fence was never checked against this deployment");
  assert.equal(s.sources.length, 2, "the socket may still hold it under the old fence: a new socket fences it again");
  s.source().hello();
  s.source().fence(15);
  assert.deepEqual(back.fences, [[CURVE, 15]]);
});

// This fails if a socket that drops during the linger is reopened with nobody to read it.
test("a socket that drops during the linger is not reopened", async () => {
  const s = setup();
  const chart = s.hub.subscribe({ pools: [CURVE], expected, listener: watcher().listener });
  s.source().hello();
  s.source().fence(10);
  chart.stop();
  await settle();
  s.source().emit("error");
  s.advance(LINGER_MS);
  assert.equal(s.sources.length, 1);
  assert.equal(s.timers.length, 0);
});

test("frames, stats and presale pongs for an awaiting pool or presale are ignored until the answer", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  const sale = `0x${"66".repeat(32)}`;
  const ready: (number | null)[] = [];
  const stats: unknown[] = [];
  const venue = watcher([VENUE]);
  s.hub.subscribe({ pools: venue.pools, expected, listener: { ...venue.listener, stats: (frame) => stats.push(frame.holders) } });
  s.hub.subscribe({ pools: [], presale: sale, expected: null, listener: { state: () => {}, presaleReady: (checkpoint) => ready.push(checkpoint) } });
  await settle();
  assert.equal(s.source().sets().at(-1)?.presale, sale);
  s.source().fence(11, VENUE);
  s.source().emit("stats", { type: "coin_stats", coin: `0x${"44".repeat(32)}::meme::MEME`, pool_key: VENUE, checkpoint: 11, timestamp_ms: NOW + 11, cursor: "11:0:0:0", provenance: wireProvenance(11), holders: 5, price: "0.5" });
  s.source().emit("hint", { type: "pong", presale_checkpoint: 40 });
  assert.deepEqual(venue.fences, []);
  assert.deepEqual(stats, []);
  assert.equal(ready.some((checkpoint) => checkpoint !== null), false);
  s.source().answer();
  s.source().fence(12, VENUE);
  s.source().emit("hint", { type: "pong", presale_checkpoint: 41 });
  assert.deepEqual(venue.fences, [[VENUE, 12]]);
  assert.equal(ready.at(-1), 41);
});

test("a set with no answer in 10 s reconnects, and a close with a set in flight redials cleanly", async () => {
  const s = setup();
  const chart = watcher();
  s.hub.subscribe({ pools: chart.pools, expected, listener: chart.listener });
  s.source().hello();
  s.source().fence(10);
  s.hub.subscribe({ pools: [VENUE], expected, listener: watcher([VENUE]).listener });
  await settle();
  s.advance(SET_ANSWER_MS);
  assert.equal(s.sources[0].closed, true);
  assert.equal(chart.states.at(-1), "reconnecting");
  s.advance(500);
  assert.equal(s.sources.length, 2);
  assert.deepEqual(s.source().pools(), [VENUE, CURVE], "the redial asks for what the tab wants");
  s.source().hello();
  assert.equal(s.source().sent.length, 0, "nothing left to set");
  s.hub.subscribe({ pools: [], priceCoins: [SUI], expected: null, listener: watcher([]).listener });
  await settle();
  assert.equal(s.source().sets().length, 1);
  s.source().emit("error");
  s.advance(1_000);
  assert.equal(s.sources.length, 3);
  assert.equal(new URL(s.source().url, "https://blast.test").searchParams.get("price_coin"), SUI);
  s.source().hello();
  assert.equal(s.source().sent.length, 0);
  assert.equal(s.timers.some((timer) => timer.ms === SET_ANSWER_MS), false, "the old answer deadline is gone");
});

test("a page load with screens subscribing over several hundred ms opens one socket", async () => {
  const s = setup();
  s.hub.subscribe({ pools: [], priceCoins: [SUI], expected: null, listener: watcher([]).listener });
  s.advance(150);
  s.hub.subscribe({ pools: [CURVE], expected, listener: watcher().listener });
  await settle();
  s.advance(150);
  s.source().hello();
  s.hub.subscribe({ pools: [VENUE], expected, listener: watcher([VENUE]).listener });
  await settle();
  assert.equal(s.sources.length, 1);
  assert.deepEqual(s.source().sets().map(({ pools }) => pools), [[CURVE]]);
  s.source().answer();
  assert.deepEqual(s.source().sets().map(({ pools }) => pools), [[CURVE], [VENUE, CURVE]]);
});

test("a set from a hidden tab during the 15 s grace still goes out", async () => {
  const s = setup();
  s.hub.subscribe({ pools: [CURVE], expected, listener: watcher().listener });
  s.source().hello();
  s.setVisible(false);
  s.hub.subscribe({ pools: [VENUE], expected, listener: watcher([VENUE]).listener });
  await settle();
  assert.equal(s.source().sets().length, 1);
});

test("a hello without set: true redials for a changed set (an older relay)", async () => {
  const s = setup();
  const a = watcher();
  const first = s.hub.subscribe({ pools: a.pools, expected, listener: a.listener });
  first.stop();
  s.hub.subscribe({ pools: [OTHER], expected, listener: watcher([OTHER]).listener });
  await settle();
  s.source().hello(false, false);
  assert.equal(s.sources[0].closed, true);
  assert.equal(s.sources[0].sent.length, 0);
  assert.equal(s.sources.length, 2);
  assert.deepEqual(s.source().pools(), [OTHER]);
});
