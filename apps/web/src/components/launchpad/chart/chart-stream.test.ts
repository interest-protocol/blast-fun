import assert from "node:assert/strict";
import test from "node:test";

import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import type { MigrationMarker, PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import type { ChartPoolRead } from "./chart-client.ts";
import { subscribeChartPrice, type ChartPriceUpdate } from "./chart-live-price.ts";
import { subscribeChartRound, type ChartRoundUpdate } from "./chart-live-round.ts";
import { ChartStream, type ChartStreamStatus } from "./chart-stream.ts";
import { MarketStreamHub, type MarketEventSource } from "../market-stream-hub.ts";
import { chartRequest } from "./chart-model.ts";

const CURVE = `blast_curve:0x${"11".repeat(32)}`;
const VENUE = `cetus:0x${"22".repeat(32)}`;
const DEPLOYMENT = "ab".repeat(32);
const NOW = 1_790_000_000_000;
const expected = { network: "mainnet" as const, deployment: DEPLOYMENT };
const wireProvenance = (checkpoint: number, timestamp = NOW + checkpoint) => ({ network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: timestamp, observed_ms: timestamp + 20, lag_ms: 20 });
const provenance = (checkpoint: number): Provenance => ({ source: "blast-infra", network: "mainnet", deployment: DEPLOYMENT, checkpoint, timestampMs: NOW + checkpoint, observedAt: NOW + checkpoint + 20, lagMs: 20 });
const page = (poolKey = CURVE): PoolCandlePage => ({ poolKey, source: poolKey === CURVE ? "curve" : "venue", venue: poolKey === CURVE ? "blast_curve" : "cetus", interval: "1s", migration: null, candles: [{ bucketStart: NOW, open: "1", close: "1", high: "1", low: "1", volumeQuote: 7n, volumeMeme: 9n, volumeUsd: null, buys: 1, sells: 0, trades: 1 }] });
const answer = (checkpoint: number, poolKey = CURVE): ChartPoolRead => ({ page: page(poolKey), section: { state: "available", data: page(poolKey), provenance: provenance(checkpoint) } });

function trade(checkpoint: number, part = 2, innerPart = 0) {
  return { type: "trade", cursor: `${checkpoint}:1:0:${part}`, checkpoint, timestamp_ms: NOW + checkpoint, provenance: wireProvenance(checkpoint), trade: { cursor: `${checkpoint}:1:0:${innerPart}`, timestamp_ms: NOW + checkpoint, digest: "1".repeat(32), pool_key: CURVE, venue: "blast_curve", trader: null, side: "buy", kind: "buy", quote_amount: "5", meme_amount: "3", price: "2", volume_usd: null, venue_swap: null } };
}

class Source implements MarketEventSource {
  closed = false;
  listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  addEventListener(type: string, listener: (event: { data?: string }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close(): void { this.closed = true; }
  emit(type: string, value: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(value) }); }
  ready(checkpoint: number, poolKey = CURVE): void { this.emit("status", { state: "live", pool_key: poolKey, checkpoint, cursor: `${checkpoint}:0:0:0`, provenance: wireProvenance(checkpoint) }); }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(pools = [CURVE], requestFrom?: number, migration: MigrationMarker | null = null, livePolls?: boolean) {
  let now = NOW;
  const sources: Source[] = [];
  const urls: string[] = [];
  const loads: { pool: string; at: number | null; resolve: (answer: ChartPoolRead) => void; reject: (error: unknown) => void }[] = [];
  const sections: { pool: string; section: Section<PoolCandlePage> }[] = [];
  const statuses: ChartStreamStatus[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const publications: (() => void)[] = [];
  const schedule = (run: () => void, ms: number) => { const timer = { run, ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; };
  const hub = new MarketStreamHub({
    createSource: (url) => { urls.push(url); const source = new Source(); sources.push(source); return source; },
    schedule, defer: queueMicrotask, settle: (run) => { run(); return () => {}; }, random: () => 0, visible: () => true, onVisibilityChange: () => () => {},
  });
  const client = new ChartStream({
    pools, expected, migration: () => migration, request: () => ({ ...chartRequest({ interval: "1s", range: "all" }, NOW), ...(requestFrom === undefined ? {} : { from: requestFrom }) }),
    load: (pool, at) => new Promise<ChartPoolRead>((resolve, reject) => loads.push({ pool, at, resolve, reject })),
    onSection: (pool, section) => sections.push({ pool, section }), onStatus: (status) => statuses.push(status),
    hub, visible: () => true, schedule, now: () => now, ...(livePolls === undefined ? {} : { livePolls }),
    publish: (run) => { publications.push(run); return () => { const index = publications.indexOf(run); if (index >= 0) publications.splice(index, 1); }; }, random: () => 0,
  });
  return { client, sources, urls, loads, sections, statuses, timers, publications, source: () => sources.at(-1)!, advance: (ms: number) => { now += ms; }, flush: () => publications.splice(0).forEach((run) => run()) };
}

test("stream opens before REST, shows behind-fence history, then applies only later checkpoints once", async () => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  const unsubscribe = subscribeChartPrice(CURVE, expected, (price) => prices.push(price));
  s.client.start();
  assert.equal(s.sources.length, 1);
  assert.equal(s.loads.length, 1);
  assert.equal(new URL(s.urls[0], "https://blast.test").searchParams.get("activity"), "true");
  s.source().ready(10);
  s.source().emit("market", trade(11));
  s.loads.shift()!.resolve(answer(9));
  await settle();
  assert.notEqual(s.statuses.at(-1), "streaming");
  const behind = s.sections.at(-1)?.section;
  assert.equal(behind?.state === "available" && behind.data.candles[0].volumeQuote, 7n, "history behind the fence is shown; frames wait");
  assert.equal(prices.at(-1)?.provenance.checkpoint, 9, "its close is the best known price");
  assert.ok(s.timers.some(({ ms }) => ms === 2_000), "the next read waits past the read's own one-second retry");
  const read = s.client.refresh();
  s.source().emit("market", trade(10));
  s.source().emit("market", trade(11));
  s.loads.shift()!.resolve(answer(10));
  await read;
  s.flush();
  const latest = s.sections.at(-1)!.section;
  assert.equal(latest.state === "available" && latest.data.candles[0].volumeQuote, 12n);
  s.source().emit("market", trade(11, 3, 0)); // distinct outer frame, same actual trade
  s.source().emit("market", trade(11, 4, 1)); // next actual trade in the same checkpoint
  s.source().emit("market", trade(11, 4, 1));
  s.flush();
  const final = s.sections.at(-1)!.section;
  assert.equal(final.state === "available" && final.data.candles[0].volumeQuote, 17n);
  s.client.stop();
  unsubscribe();
  await settle(); // the hub closes once no subscriber is left
  assert.equal(s.source().closed, true);
  assert.equal(s.timers.length, 0);
});

test("a chart shown stale while the relay's upstream lags streams again when it is fresh", async () => {
  const s = setup();
  s.client.start();
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(1) });
  s.source().ready(10);
  s.loads.shift()!.resolve(answer(10));
  await settle();
  assert.equal(s.statuses.at(-1), "streaming");
  s.source().emit("status", { state: "stale" });
  assert.equal(s.statuses.at(-1), "recovering");
  s.source().emit("status", { state: "fresh" });
  assert.equal(s.statuses.at(-1), "streaming", "no fence or read comes: the fresh upstream alone resumes streaming");
  assert.equal(s.loads.length, 0);
  s.client.stop();
});

test("a seeded pool starts from its own fence and only a behind pool reads again", async () => {
  const s = setup([CURVE, VENUE]);
  s.client.start([[CURVE, answer(10)], [VENUE, answer(18, VENUE)]]);
  assert.equal(s.loads.length, 0);
  s.source().ready(10, CURVE);
  s.source().ready(20, VENUE);
  assert.deepEqual(s.loads.map(({ pool }) => pool), [VENUE]);
  s.source().emit("market", trade(10));
  s.source().emit("market", trade(11, 3));
  s.loads[0].resolve(answer(20, VENUE));
  await settle();
  s.flush();
  const curve = s.sections.filter(({ pool }) => pool === CURVE).at(-1)?.section;
  assert.equal(curve?.state === "available" && curve.data.candles[0].volumeQuote, 12n);
  assert.equal(s.statuses.at(-1), "streaming");
  s.client.stop();
});

test("periodic stale REST cannot erase already-applied trades or roll the header price back", async () => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  const unsubscribe = subscribeChartPrice(CURVE, expected, (price) => prices.push(price));
  s.client.start(); s.source().ready(10); s.loads.shift()!.resolve(answer(10)); await settle();
  assert.equal(prices.at(-1)?.cursor, null);
  s.source().emit("market", trade(12)); s.flush();
  assert.equal(prices.at(-1)?.price, "2");
  const refreshing = s.client.refresh();
  let done = false;
  const joined = s.client.refresh().then(() => { done = true; });
  await settle(); assert.equal(done, false, "manual refresh joins the actual in-flight read");
  const shown = s.sections.length;
  s.loads.shift()!.resolve(answer(11)); await refreshing; await joined;
  assert.equal(prices.at(-1)?.price, "2");
  assert.equal(s.sections.length, shown, "the older read changes nothing on screen");
  assert.equal(s.loads.length, 0, "and reads nothing more");
  s.client.stop(); unsubscribe();
});

test("a swap advances the close while the regular history read is in flight", async () => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  const unsubscribe = subscribeChartPrice(CURVE, expected, (price) => prices.push(price));
  s.client.start(); s.source().ready(10); s.loads.shift()!.resolve(answer(10)); await settle();

  const refresh = s.client.refresh();
  s.source().emit("market", trade(11));
  const latest = s.sections.at(-1)?.section;
  assert.equal(latest?.state === "available" && latest.data.candles.at(-1)?.close, "2");
  assert.equal(prices.at(-1)?.price, "2");

  s.loads.shift()!.resolve(answer(10)); await refresh;
  assert.equal(prices.at(-1)?.price, "2", "a periodic answer that raced the trade cannot roll it back");

  s.source().emit("error");
  assert.equal(prices.at(-1), null);
  const recoveryRead = s.client.refresh();
  s.loads.shift()!.resolve(answer(11)); await recoveryRead;
  assert.equal(prices.at(-1)?.provenance.checkpoint, 11, "a read as new as the shown trade is the best known price");
  const reconnect = s.timers.find((timer) => timer.ms === 500)!;
  reconnect.run();
  s.source().ready(12);
  assert.equal(prices.at(-1)?.provenance.checkpoint, 11, "a fence ahead of the read keeps its price until the next read");
  s.loads.shift()!.resolve(answer(12)); await settle();
  assert.equal(prices.at(-1)?.provenance.checkpoint, 12);
  s.client.stop(); unsubscribe();
});

test("one pool's newer snapshot never advances the other pool's independent cutoff", async () => {
  const s = setup([CURVE, VENUE]);
  s.client.start(); s.source().ready(10, CURVE); s.source().ready(20, VENUE);
  s.loads.find((load) => load.pool === CURVE)!.resolve(answer(10, CURVE));
  s.loads.find((load) => load.pool === VENUE)!.resolve(answer(20, VENUE)); await settle();
  s.source().emit("market", trade(11)); s.flush();
  const latest = s.sections.filter((item) => item.pool === CURVE).at(-1)!.section;
  assert.equal(latest.state === "available" && latest.data.candles[0].volumeQuote, 12n);
  assert.equal(new URL(s.urls[0], "https://blast.test").searchParams.getAll("pool").length, 2);
  s.client.stop();
});

test("an unpriced trade keeps both readouts blank through history reads and a reconnect", async (t) => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start(); s.source().ready(10); s.loads.shift()!.resolve(answer(10)); await settle();
  t.after(() => s.client.stop());
  const unpriced = trade(11);
  s.source().emit("market", { ...unpriced, trade: { ...unpriced.trade, price: null } });
  assert.equal(prices.at(-1), null);
  const read = s.client.refresh();
  s.loads.shift()!.resolve(answer(11)); await read;
  assert.equal(prices.at(-1), null, "candles alone can omit the unpriced trade");
  s.source().emit("error");
  s.timers.find(({ ms }) => ms === 500)!.run();
  s.source().emit("status", { state: "live", pool_key: CURVE, checkpoint: 12, cursor: "12:0:0:0", provenance: wireProvenance(12), price_missing: true });
  s.loads.shift()!.resolve(answer(12)); await settle();
  assert.equal(prices.at(-1), null);
  s.source().emit("market", trade(13)); s.flush();
  assert.equal(prices.at(-1)?.price, "2");
});

test("a healthy heartbeat cannot validate a delayed frame or renew old price proof", async (t) => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().emit("hint", { type: "hello", heartbeat: true, provenance: wireProvenance(10) });
  s.source().ready(10); s.loads.shift()!.resolve(answer(10)); await settle();
  assert.equal(prices.at(-1)?.price, "1");
  s.advance(30_000);
  s.source().emit("heartbeat");
  s.timers.find(({ ms }) => ms === 29_980)!.run();
  assert.equal(prices.at(-1), null, "proof expires while the socket remains connected");
  s.advance(1_000);
  s.source().emit("market", trade(11)); s.flush();
  assert.equal(prices.at(-1), null, "a frame delayed in transit cannot republish the old close");
  assert.equal(s.source().closed, false);
});

test("a silent market stream clears the shared price nine seconds after its last heartbeat", async (t) => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().emit("hint", { type: "hello", heartbeat: true, heartbeat_ms: 4_000, provenance: wireProvenance(10) });
  s.source().ready(10);
  s.loads.shift()!.resolve(answer(10));
  await settle();
  assert.equal(prices.at(-1)?.price, "1");

  const initialDeadline = s.timers.find(({ ms }) => ms === 9_000);
  assert.ok(initialDeadline, "the advertised cadence sets a nine-second deadline");
  s.advance(6_000);
  s.source().emit("hint", { type: "pong" });
  assert.equal(s.timers.includes(initialDeadline), false, "the first upstream pong resets the startup deadline");
  const handshakeDeadline = s.timers.find(({ ms }) => ms === 9_000);
  assert.ok(handshakeDeadline);
  s.advance(4_000);
  s.source().emit("heartbeat");
  assert.equal(s.timers.includes(handshakeDeadline), false, "a healthy heartbeat resets the deadline");
  assert.equal(prices.at(-1)?.price, "1");

  const renewedDeadline = s.timers.find(({ ms }) => ms === 9_000);
  assert.ok(renewedDeadline);
  s.advance(9_000);
  renewedDeadline.run();
  assert.equal(s.source().closed, true);
  assert.equal(prices.at(-1), null);
});

test("disconnect invalidates prices, settles late reads harmlessly and retries with bounded backoff", async () => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  const unsubscribe = subscribeChartPrice(CURVE, expected, (price) => prices.push(price));
  s.client.start(); s.source().ready(10);
  const old = s.loads.shift()!;
  s.source().emit("error");
  assert.equal(s.source().closed, true);
  assert.equal(prices.at(-1), null);
  old.resolve(answer(10)); await settle();
  assert.equal(s.sections.length, 0);
  const reconnect = s.timers.find((timer) => timer.ms === 500)!;
  s.timers.splice(s.timers.indexOf(reconnect), 1); reconnect.run();
  assert.equal(s.sources.length, 2);
  s.source().ready(12); const loading = s.loads.at(-1)!;
  s.client.stop(); loading.resolve(answer(12)); await settle();
  assert.equal(s.sections.length, 0);
  assert.equal(s.timers.length, 0);
  unsubscribe();
});

// This fails if a chart whose history read lags behind a busy pool ends the tab's socket, or
// re-fences its other pool, instead of reading that one pool again through its newest frame.
test("a buffer overflow re-fences only its pool, and a foreign deployment's fence ends nothing", async () => {
  const s = setup([CURVE, VENUE]);
  s.client.start(); s.source().ready(10); s.source().ready(10, VENUE);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  for (let i = 0; i < 129; i++) s.source().emit("market", trade(11 + i));
  assert.equal(s.source().closed, false, "the socket stays");
  assert.equal(s.sources.length, 1);
  assert.equal(s.statuses.at(-1), "recovering");
  s.loads.find((load) => load.pool === CURVE)!.resolve(answer(10));
  s.loads.find((load) => load.pool === VENUE)!.resolve(answer(10, VENUE));
  await settle();
  const retry = s.timers.find((timer) => timer.ms === 2_000)!;
  s.timers.splice(s.timers.indexOf(retry), 1); retry.run();
  assert.deepEqual(s.loads.filter((load) => load.at !== null).map(({ pool, at }) => [pool, at]).at(-1), [CURVE, 114], "the pool reads through the frame that overflowed (the 64 KiB bound comes first)");
  assert.equal(s.loads.filter((load) => load.pool === VENUE).length, 1, "the other pool reads nothing more");
  s.client.stop();
  const foreign = setup(); foreign.client.start();
  foreign.source().emit("status", { state: "live", pool_key: CURVE, checkpoint: 10, cursor: "10:0:0:0", provenance: { ...wireProvenance(10), deployment_fingerprint: "cd".repeat(32) } });
  assert.equal(foreign.source().closed, false);
  foreign.source().emit("market", trade(11));
  assert.equal(foreign.loads.length, 1, "a frame for a pool without a fence is dropped");
  foreign.loads.shift()!.resolve(answer(10)); await settle(); foreign.client.stop();
});

test("a burst of accepted frames produces one pending chart repaint", async () => {
  const s = setup();
  s.client.start(); s.source().ready(10); s.loads.shift()!.resolve(answer(10)); await settle();
  s.source().emit("market", trade(11));
  const first = s.sections.at(-1)?.section;
  assert.equal(first?.state === "available" && first.data.candles[0].volumeQuote, 12n, "first buy reaches the chart in the receipt turn");
  const count = s.sections.length;
  s.source().emit("market", trade(12)); s.source().emit("market", trade(13));
  assert.equal(s.sections.length, count);
  assert.equal(s.publications.length, 1, "one pending repaint for a burst of accepted frames");
  s.flush();
  const final = s.sections.at(-1)?.section;
  assert.equal(final?.state === "available" && final.data.candles[0].volumeQuote, 22n);
  s.flush();
  assert.equal(s.publications.length, 0, "an idle chart stops scheduling paints");
  s.client.stop();
});

test("a fenced close stays current without trades in the selected range", async () => {
  const s = setup([CURVE], NOW);
  const prices: (ChartPriceUpdate | null)[] = [];
  const unsubscribe = subscribeChartPrice(CURVE, expected, (price) => prices.push(price));
  const prior = { ...page().candles[0], bucketStart: NOW - 86_400_000 };
  const history = { ...page(), candles: [prior] };
  s.client.start();
  s.source().ready(10);
  s.loads.shift()!.resolve({ page: history, section: { state: "available", data: history, provenance: provenance(10) } });
  await settle();
  assert.equal(prices.at(-1)?.price, "1");
  const refresh = s.client.refresh();
  s.source().emit("market", trade(11));
  assert.equal(prices.at(-1)?.price, "2");
  const latest = s.sections.at(-1)?.section;
  assert.equal(latest?.state === "available" && latest.data.candles.at(-1)?.open, prior.close);
  s.loads.shift()!.resolve(answer(10));
  await refresh;
  assert.equal(prices.at(-1)?.price, "2");
  s.client.stop();
  unsubscribe();
});

test("bounded empty history recovers the trade's previous-close anchor before publishing its price", async () => {
  const s = setup([CURVE], NOW);
  const prices: (ChartPriceUpdate | null)[] = [];
  const unsubscribe = subscribeChartPrice(CURVE, expected, (price) => prices.push(price));
  s.client.start(); s.source().ready(10);
  s.loads.shift()!.resolve({ page: { ...page(), candles: [] }, section: { state: "empty", provenance: provenance(10) } }); await settle();
  s.source().emit("market", trade(11)); s.flush();
  assert.equal(prices.at(-1), null);
  assert.equal(s.statuses.at(-1), "recovering");
  const retry = s.timers.find((timer) => timer.ms === 500)!;
  s.timers.splice(s.timers.indexOf(retry), 1); retry.run();
  const authoritative = { ...page(), candles: [{ ...page().candles[0], close: "2", high: "2", volumeQuote: 5n, volumeMeme: 3n }] };
  s.loads.shift()!.resolve({ page: authoritative, section: { state: "available", data: authoritative, provenance: provenance(11) } }); await settle();
  assert.equal(prices.at(-1)?.price, "2");
  assert.equal(prices.at(-1)?.cursor, null);
  s.client.stop(); unsubscribe();
});

test("a quiet pool with no close after the checkpoint still shows the price", async (t) => {
  const s = setup();
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  // The stream never serves this pool: its history polls carry the page.
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.source().emit("status", { state: "unavailable", pool_key: CURVE });
  assert.equal(s.statuses.at(-1), "unavailable");
  s.loads.shift()!.resolve(answer(10)); await settle();
  assert.equal(prices.at(-1)?.price, "1");
  assert.equal(prices.at(-1)?.cursor, null);
  // No trade since: the next poll's last close is still the one before its checkpoint.
  s.timers.find(({ ms }) => ms === 15_000)!.run();
  s.loads.shift()!.resolve(answer(14)); await settle();
  assert.equal(prices.at(-1)?.price, "1");
  assert.equal(prices.at(-1)?.provenance.checkpoint, 14);
  assert.ok(s.sections.every(({ section }) => section.state === "available"), "nothing turns stale");
  // A pool read before the stream gave up on it keeps its price too.
  const latePrices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(VENUE, expected, (price) => latePrices.push(price)));
  const shown = setup([VENUE]);
  t.after(() => shown.client.stop());
  shown.client.start();
  shown.loads.shift()!.resolve(answer(10, VENUE)); await settle();
  shown.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  shown.source().emit("status", { state: "unavailable", pool_key: VENUE });
  assert.equal(latePrices.at(-1)?.price, "1");
  assert.ok(shown.sections.every(({ section }) => section.state === "available"));
});

test("the hello clears the connection deadline, a pool waiting for its fence does not end the socket, and a missing hello reconnects", async () => {
  const s = setup([CURVE, VENUE]);
  s.client.start(); s.source().ready(10, CURVE);
  assert.ok(s.timers.some((timer) => timer.ms === 10_000));
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  assert.equal(s.timers.some((timer) => timer.ms === 10_000), false, "VENUE's fence is its own: the socket is up");
  s.source().ready(20, VENUE);
  for (const load of s.loads) load.resolve(answer(load.pool === CURVE ? 10 : 20, load.pool));
  await settle(); s.client.stop();
  const stalled = setup(); stalled.client.start();
  const deadline = stalled.timers.find((timer) => timer.ms === 10_000)!;
  stalled.timers.splice(stalled.timers.indexOf(deadline), 1); deadline.run();
  assert.equal(stalled.source().closed, true);
  assert.equal(stalled.statuses.at(-1), "reconnecting");
  stalled.loads.shift()!.resolve(answer(10)); await settle(); stalled.client.stop();
});

function round(checkpoint: number, bidders: number) {
  return { type: "opening_round", cursor: `${checkpoint}:2:0:0`, checkpoint, timestamp_ms: NOW + checkpoint, pool_key: CURVE, provenance: wireProvenance(checkpoint), opening_round: { duration_ms: "3600000", starts_at_ms: String(NOW), ends_at_ms: String(NOW + 3_600_000), total_committed_quote: "5", bidder_count: bidders, settlement: null, delivered_count: 0, undelivered_count: bidders, state: "open" } };
}

test("opening round frames reach the coin page without buffering, reloading history or reconnecting", async () => {
  const s = setup();
  const rounds: ChartRoundUpdate[] = [];
  const unsubscribe = subscribeChartRound(CURVE, expected, (update) => rounds.push(update));
  const foreign = subscribeChartRound(CURVE, { ...expected, deployment: "cd".repeat(32) }, () => assert.fail("foreign deployment"));
  s.client.start(); s.source().ready(10);
  // While history loads, more rounds than the frame buffer holds still pass straight through.
  for (let i = 0; i < 200; i++) s.source().emit("market", round(11 + i, i + 1));
  assert.equal(s.source().closed, false);
  assert.equal(rounds.length, 200);
  assert.equal(rounds.at(-1)?.openingRound.bidderCount, 200);
  assert.equal(rounds.at(-1)?.provenance.checkpoint, 210);
  s.loads.shift()!.resolve(answer(10)); await settle();
  const sections = s.sections.length;
  s.source().emit("market", round(300, 201));
  s.source().emit("market", trade(301));
  s.flush();
  assert.equal(rounds.at(-1)?.openingRound.bidderCount, 201);
  assert.equal(s.sources.length, 1);
  assert.equal(s.source().closed, false);
  assert.equal(s.loads.length, 0, "no history refetch");
  const latest = s.sections.at(-1)!.section;
  assert.equal(s.sections.length, sections + 1, "only the trade repaints the chart");
  assert.equal(latest.state === "available" && latest.data.candles[0].volumeQuote, 12n);
  s.client.stop(); unsubscribe(); foreign();
});

test("history read before the stream's fence starts the stream without a second read; an older one reads again", async () => {
  const s = setup([CURVE, VENUE]);
  s.client.start();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE, VENUE]);
  s.loads.shift()!.resolve(answer(10));
  s.loads.shift()!.resolve(answer(8, VENUE));
  await settle();
  s.source().ready(10);
  s.source().ready(9, VENUE);
  assert.deepEqual(s.loads.map((load) => load.pool), [VENUE], "only the venue read is behind its fence");
  s.loads.shift()!.resolve(answer(9, VENUE));
  await settle();
  assert.equal(s.statuses.at(-1), "streaming");
  s.source().emit("market", trade(11));
  s.flush();
  const latest = s.sections.findLast((item) => item.pool === CURVE)!.section;
  assert.equal(latest.state === "available" && latest.data.candles[0].volumeQuote, 12n, "frames after the kept read apply");
  s.client.stop();
});

test("a read behind the fence but past the pool's last event starts the stream without a second read", async () => {
  const s = setup([CURVE, VENUE]);
  // The stream fences each pool at 12; the curve last traded at 8, the venue at 11.
  const fence = (poolKey: string, last: number) =>
    s.source().emit("status", { state: "live", pool_key: poolKey, checkpoint: 12, cursor: `${last}:1:0:2`, provenance: wireProvenance(12) });
  s.client.start();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE, VENUE]);
  fence(CURVE, 8);
  s.loads.shift()!.resolve(answer(10));
  s.loads.shift()!.resolve(answer(10, VENUE));
  await settle();
  fence(VENUE, 11);
  assert.deepEqual(s.loads.map(({ pool, at }) => [pool, at]), [[VENUE, 11]], "only the venue, which traded after its read, reads again, up to that trade");
  assert.ok(!s.timers.some(({ ms }) => ms === 2_000), "no behind-fence retry for the curve");
  s.loads.shift()!.resolve(answer(11, VENUE));
  await settle();
  assert.equal(s.loads.length, 0);
  assert.equal(s.statuses.at(-1), "streaming");
  s.source().emit("market", trade(13));
  s.flush();
  const latest = s.sections.findLast((item) => item.pool === CURVE)!.section;
  assert.equal(latest.state === "available" && latest.data.candles[0].volumeQuote, 12n, "frames after the fence apply on the kept read");
  s.client.stop();
});

test("a migrated coin's curve history is read once, then only its venue pool is polled", async () => {
  const migration = { cursor: "5:0:0:0", timestampMs: NOW + 5, curvePoolKey: CURVE, venuePoolKey: VENUE };
  const migrated = (checkpoint: number, poolKey: string): ChartPoolRead => {
    const data = { ...page(poolKey), migration };
    return { page: data, section: { state: "available", data, provenance: provenance(checkpoint) } };
  };
  const s = setup([CURVE, VENUE], undefined, migration);
  s.client.start();
  s.loads.shift()!.resolve(migrated(10, CURVE));
  s.loads.shift()!.resolve(migrated(10, VENUE));
  await settle();
  const poll = () => s.timers.find((timer) => timer.ms === 15_000)!.run();
  poll();
  assert.deepEqual(s.loads.map((load) => load.pool), [VENUE]);
  s.loads.shift()!.resolve(migrated(11, VENUE));
  await settle();
  poll();
  assert.deepEqual(s.loads.map((load) => load.pool), [VENUE]);
  s.client.stop();
});

test("the live screen reads no history on the poll while the stream is live, and polls again once it drops", async () => {
  const s = setup([CURVE], undefined, null, false);
  s.client.start();
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  const poll = () => s.timers.find((timer) => timer.ms === 15_000)!.run();
  poll();
  poll();
  assert.equal(s.loads.length, 0);
  s.source().emit("error");
  await settle();
  s.loads.splice(0);
  poll();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE]);
  s.client.stop();
});

// This fails if one pool the relay cannot serve stops the chart's other pool from streaming, or
// leaves that pool without polls.
test("the live screen polls only the pool that is not live; the other streams without reads", async () => {
  const s = setup([CURVE, VENUE], undefined, null, false);
  s.client.start();
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.source().emit("status", { state: "unavailable", pool_key: VENUE });
  for (const load of s.loads.splice(0)) load.resolve(answer(10, load.pool));
  await settle();
  const poll = () => s.timers.find((timer) => timer.ms === 15_000)!.run();
  poll();
  assert.deepEqual(s.loads.map((load) => load.pool), [VENUE]);
  for (const load of s.loads.splice(0)) load.resolve(answer(11, load.pool));
  await settle();
  s.source().emit("market", trade(12));
  assert.equal(s.source().closed, false);
  assert.equal(s.statuses.includes("reconnecting"), false);
  s.client.stop();
});

// This fails if the live screen reads a quiet pool's history again while its stream stays live.
test("on a live stream a quiet pool keeps its price with no reads; it ends, and reads resume, once the stream is stale", async (t) => {
  const s = setup([CURVE], undefined, null, false);
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  const poll = () => s.timers.find((timer) => timer.ms === 15_000)!.run();
  s.advance(30_000);
  s.timers.find(({ ms }) => ms === 29_980)!.run();
  poll();
  s.advance(60_000);
  poll();
  assert.equal(s.loads.length, 0, "no read while the pool is live");
  assert.equal(prices.includes(null), false, "the price outlives its proof while the pool is live");
  s.source().emit("market", trade(90_000)); s.flush();
  assert.equal(prices.at(-1)?.provenance.checkpoint, 90_000, "a trade still moves it");
  s.advance(31_000);
  s.timers.filter(({ ms }) => ms === 29_980).at(-1)!.run();
  s.source().emit("status", { state: "stale" });
  assert.equal(prices.at(-1), null, "a held price ends when the stream goes stale");
  poll();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE], "and the reads resume");
});

// This fails if a price whose proof is still running is dropped when the stream goes stale, or held once it runs out there.
test("a price within its proof stays when the stream goes stale, and ends when the proof runs out there", async (t) => {
  const s = setup([CURVE], undefined, null, false);
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  s.source().emit("status", { state: "stale" });
  assert.equal(prices.includes(null), false);
  s.advance(30_000);
  s.timers.find(({ ms }) => ms === 29_980)!.run();
  assert.equal(prices.at(-1), null);
});

// This fails if a quiet pool's price, dropped during a short stale spell, stays "—" once the stream is live again.
test("a price dropped while the stream was stale is read again on the next tick once it is live, even after a failed read", async (t) => {
  const s = setup([CURVE], undefined, null, false);
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  const poll = () => s.timers.find((timer) => timer.ms === 15_000)!.run();
  s.advance(30_000);
  s.timers.find(({ ms }) => ms === 29_980)!.run();
  s.source().emit("status", { state: "stale" });
  s.source().emit("status", { state: "fresh" });
  assert.equal(prices.at(-1), null);
  assert.equal(s.statuses.at(-1), "streaming");
  poll();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE], "the missing price is read");
  s.loads.shift()!.reject(new Error("429"));
  await settle();
  assert.equal(s.statuses.at(-1), "streaming", "a failed read leaves the live chart as it is");
  s.advance(1_000);
  poll();
  s.loads.shift()!.resolve(answer(31_000));
  await settle();
  assert.equal(prices.at(-1)?.provenance.checkpoint, 31_000, "the price returns");
  poll();
  assert.equal(s.loads.length, 0, "and the reads rest again");
});

// This fails if a re-fence of a quiet pool replays its old read as the price and never reads again.
test("a quiet pool fenced again after its proof ran out reads its price on the next tick", async (t) => {
  const s = setup([CURVE], undefined, null, false);
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  s.advance(40_000);
  s.source().emit("status", { state: "recovering", pool_key: CURVE });
  s.source().ready(10);
  assert.equal(s.loads.length, 0, "the fence reuses the read that reaches it");
  assert.equal(prices.at(-1), null, "whose price is too old to show");
  s.timers.find((timer) => timer.ms === 15_000)!.run();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE]);
  s.loads.shift()!.resolve(answer(40_000));
  await settle();
  assert.equal(prices.at(-1)?.provenance.checkpoint, 40_000);
});

test("on a live stream a quiet pool shown stale reads again on the next tick and recovers its price", async (t) => {
  const s = setup([CURVE], undefined, null, false);
  const prices: (ChartPriceUpdate | null)[] = [];
  t.after(subscribeChartPrice(CURVE, expected, (price) => prices.push(price)));
  s.client.start();
  t.after(() => s.client.stop());
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  s.advance(60_000);
  s.source().emit("market", trade(20)); s.flush();
  assert.equal(s.sections.at(-1)?.section.state, "stale");
  assert.equal(prices.at(-1), null);
  assert.equal(s.statuses.at(-1), "streaming");
  s.timers.find((timer) => timer.ms === 15_000)!.run();
  assert.deepEqual(s.loads.map((load) => load.pool), [CURVE], "stale history is read again");
  s.loads.shift()!.resolve(answer(60_000));
  await settle();
  assert.equal(prices.at(-1)?.provenance.checkpoint, 60_000, "the price returns once the indexer catches up");
});

// This fails if a refused socket (off, 4429, or failing) leaves the live
// screen without history polls until the socket comes back.
test("while the socket is refused the live screen's history polls resume, and stop again once it is live", async () => {
  const s = setup([CURVE], undefined, null, false);
  s.client.start();
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  s.loads.shift()!.resolve(answer(10));
  await settle();
  const poll = async () => {
    s.timers.find((timer) => timer.ms === 15_000)!.run();
    const read = s.loads.splice(0);
    for (const load of read) load.resolve(answer(10));
    await settle();
    return read.map((load) => load.pool);
  };
  assert.deepEqual(await poll(), [], "no read while live");
  s.source().listeners.get("refused")![0]!({ data: "600000" });
  await settle();
  assert.equal(s.statuses.at(-1), "unavailable");
  s.loads.splice(0);
  assert.deepEqual(await poll(), [CURVE]);
  assert.deepEqual(await poll(), [CURVE], "every poll reads while the hub is not live");
  const retry = s.timers.find((timer) => timer.ms === 600_000)!;
  s.timers.splice(s.timers.indexOf(retry), 1);
  retry.run();
  s.source().ready(10);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  await settle();
  s.loads.splice(0).forEach((load) => load.resolve(answer(10)));
  await settle();
  assert.deepEqual(await poll(), [], "the socket is back: polls stop");
  s.client.stop();
});

test("a tab shown after a long hide reads history at once, as a fresh chart did", async () => {
  let visible = true;
  let onVisibility = () => {};
  const timers: { run: () => void; ms: number }[] = [];
  const schedule = (run: () => void, ms: number) => { const timer = { run, ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; };
  const hub = new MarketStreamHub({
    createSource: () => new Source(), schedule, defer: queueMicrotask, settle: (run) => { run(); return () => {}; }, random: () => 0, visible: () => visible,
    onVisibilityChange: (listener) => { onVisibility = listener; return () => {}; },
  });
  const loads: string[] = [];
  const client = new ChartStream({
    pools: [CURVE], expected, migration: () => null, request: () => chartRequest({ interval: "1s", range: "all" }, NOW),
    load: (pool) => { loads.push(pool); return Promise.resolve(answer(9, pool)); },
    onSection: () => {}, onStatus: () => {}, hub, visible: () => visible, schedule, publish: () => () => {}, random: () => 0,
  });
  client.start();
  assert.equal(loads.length, 1);
  await settle();
  visible = false;
  onVisibility();
  const grace = timers.at(-1)!; // the hub's hide grace, beside the chart's own 15 s poll
  assert.equal(grace.ms, 15_000);
  timers.splice(timers.indexOf(grace), 1);
  grace.run();
  visible = true;
  onVisibility();
  assert.equal(loads.length, 2);
  client.stop();
});
