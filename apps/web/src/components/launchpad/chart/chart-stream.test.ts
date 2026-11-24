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

function setup(pools = [CURVE], requestFrom?: number, migration: MigrationMarker | null = null) {
  const sources: Source[] = [];
  const urls: string[] = [];
  const loads: { pool: string; resolve: (answer: ChartPoolRead) => void }[] = [];
  const sections: { pool: string; section: Section<PoolCandlePage> }[] = [];
  const statuses: ChartStreamStatus[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const publications: (() => void)[] = [];
  const schedule = (run: () => void, ms: number) => { const timer = { run, ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; };
  const hub = new MarketStreamHub({
    createSource: (url) => { urls.push(url); const source = new Source(); sources.push(source); return source; },
    schedule, defer: queueMicrotask, random: () => 0, visible: () => true, onVisibilityChange: () => () => {},
  });
  const client = new ChartStream({
    pools, expected, migration: () => migration, request: () => ({ ...chartRequest({ interval: "1s", range: "all" }, NOW), ...(requestFrom === undefined ? {} : { from: requestFrom }) }),
    load: (pool) => new Promise<ChartPoolRead>((resolve) => loads.push({ pool, resolve })),
    onSection: (pool, section) => sections.push({ pool, section }), onStatus: (status) => statuses.push(status),
    hub, visible: () => true, schedule,
    publish: (run) => { publications.push(run); return () => { const index = publications.indexOf(run); if (index >= 0) publications.splice(index, 1); }; }, random: () => 0,
  });
  return { client, sources, urls, loads, sections, statuses, timers, publications, source: () => sources.at(-1)!, flush: () => publications.splice(0).forEach((run) => run()) };
}

test("stream opens before REST, rejects behind-fence history, then applies only later checkpoints once", async () => {
  const s = setup();
  s.client.start();
  assert.equal(s.sources.length, 1);
  assert.equal(s.loads.length, 1);
  assert.equal(new URL(s.urls[0], "https://blast.test").searchParams.get("activity"), "true");
  s.source().ready(10);
  s.source().emit("market", trade(11));
  s.loads.shift()!.resolve(answer(9));
  await settle();
  assert.notEqual(s.statuses.at(-1), "streaming");
  assert.equal(s.sections.at(-1)?.section.state, "unavailable");
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
  await settle(); // the hub closes once no subscriber is left
  assert.equal(s.source().closed, true);
  assert.equal(s.timers.length, 0);
});

test("periodic stale REST cannot erase already-applied trades or publish an older header price", async () => {
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
  s.loads.shift()!.resolve(answer(11)); await refreshing; await joined;
  assert.equal(prices.at(-1), null);
  assert.equal(s.sections.at(-1)?.section.state, "unavailable");
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

test("overflow and malformed deployment frames close the stream and preserve recovery requirements", async () => {
  const s = setup();
  s.client.start(); s.source().ready(10);
  for (let i = 0; i < 129 && !s.source().closed; i++) s.source().emit("market", trade(11 + i));
  assert.equal(s.source().closed, true);
  assert.equal(s.statuses.at(-1), "reconnecting");
  s.loads.shift()!.resolve(answer(10)); await settle(); s.client.stop();
  const foreign = setup(); foreign.client.start();
  foreign.source().emit("status", { state: "live", pool_key: CURVE, checkpoint: 10, cursor: "10:0:0:0", provenance: { ...wireProvenance(10), deployment_fingerprint: "cd".repeat(32) } });
  assert.equal(foreign.source().closed, true);
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

test("all pool fences and valid hint hello are required before clearing the connection deadline", async () => {
  const s = setup([CURVE, VENUE]);
  s.client.start(); s.source().ready(10, CURVE);
  s.source().emit("hint", { type: "hello", provenance: wireProvenance(10) });
  assert.ok(s.timers.some((timer) => timer.ms === 10_000));
  s.source().ready(20, VENUE);
  assert.equal(s.timers.some((timer) => timer.ms === 10_000), false);
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

test("a tab shown after a long hide reads history at once, as a fresh chart did", async () => {
  let visible = true;
  let onVisibility = () => {};
  const timers: { run: () => void; ms: number }[] = [];
  const schedule = (run: () => void, ms: number) => { const timer = { run, ms }; timers.push(timer); return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }; };
  const hub = new MarketStreamHub({
    createSource: () => new Source(), schedule, defer: queueMicrotask, random: () => 0, visible: () => visible,
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
