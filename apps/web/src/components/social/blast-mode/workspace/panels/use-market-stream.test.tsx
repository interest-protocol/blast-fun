import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarketStreamHub, type MarketEventSource } from "#web/components/launchpad/market-stream-hub.ts";
import { WorkspaceLiveProvider } from "../live-clock";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock";
import type { MarketCoinHistory } from "./coin-market-history";
import { coinPollMs, useCoinRead } from "./use-coin-read";
import { useMarketStream } from "./use-market-stream";

const POOL = `blast_curve:0x${"11".repeat(32)}`;
const COIN = `0x${"22".repeat(32)}::meme::MEME`;
const DEPLOYMENT = "ab".repeat(32);
const NOW = 1_790_000_040_000;
const BUCKET = NOW - (NOW % 60_000);
const wire = (checkpoint: number) => ({ network: "mainnet", deployment_fingerprint: DEPLOYMENT, checkpoint, timestamp_ms: NOW + checkpoint, observed_ms: NOW + checkpoint + 20, lag_ms: 20 });

/** A curve coin's history read at `checkpoint`, one 1 m candle closing at 2 quote atoms per meme atom. */
function history(checkpoint: number): MarketCoinHistory {
  return {
    kind: "market",
    coin_type: COIN,
    page: { coinType: COIN, interval: "1m", migration: null, candles: [{ bucketStart: BUCKET, open: "2", high: "2", low: "2", close: "2", volumeQuote: 5n, volumeMeme: 3n, volumeUsd: null, buys: 1, sells: 0, trades: 1 }] },
    request: { interval: "1m", capped: false },
    stale: false,
    provenance: { source: "blast-infra", network: "mainnet", deployment: DEPLOYMENT, checkpoint, timestampMs: NOW + checkpoint, observedAt: NOW + checkpoint, lagMs: 0 },
    decimals: 9,
    quoteDecimals: 9,
    poolKey: POOL,
  };
}

/** A buy at 3 quote atoms per meme atom; the quote is worth $3.4521 (Pyth price 345210000, expo −8). */
function trade(checkpoint: number) {
  const cursor = `${checkpoint}:1:0:2`;
  return {
    type: "trade", cursor, checkpoint, timestamp_ms: NOW + checkpoint, provenance: wire(checkpoint),
    summary: { quote: "0x2::sui::SUI", price: "3", inputs: { meme_decimals: "9", quote_decimals: "9" }, quote_usd: { price: "345210000", expo: -8, publish_time: 1, age_ms: 0 } },
    trade: { cursor, timestamp_ms: NOW + checkpoint, digest: "1".repeat(32), pool_key: POOL, venue: "blast_curve", trader: null, side: "buy", kind: "buy", quote_amount: "5", meme_amount: "3", price: "3", volume_usd: null, venue_swap: null },
  };
}

class Source implements MarketEventSource {
  readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  addEventListener(type: string, listener: (event: { data?: string }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  close(): void {}
  emit(type: string, value: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(value) }); }
}

test("Blast mode's focused coin moves on stream trades, keeps its stream across reads, and polls at 30 s while live, 15 s otherwise", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const time = handClock(NOW);
  const sources: Source[] = [];
  const hub = new MarketStreamHub({
    createSource: () => { const source = new Source(); sources.push(source); return source; },
    schedule: () => () => {},
    defer: queueMicrotask, settle: (run) => { run(); return () => {}; }, random: () => 0, visible: () => true, onVisibilityChange: () => () => {},
  });
  let checkpoint = 10;
  let reads = 0;
  let setKey: (key: string) => void = () => {};
  const read = async () => { reads++; return history(checkpoint); };
  function Subject() {
    const [live, setLive] = useState(false);
    const [key, changeKey] = useState("coin:24h");
    setKey = changeKey;
    const base = useCoinRead(true, key, read, undefined, coinPollMs(live));
    const stream = useMarketStream(COIN, base.value, true, base.refresh, hub);
    if (stream.live !== live) setLive(stream.live);
    const last = stream.history?.page.candles.at(-1);
    return <output>{JSON.stringify({ live, close: last?.close, trades: last?.trades, price: stream.price })}</output>;
  }
  const shown = () => JSON.parse(document.querySelector("output")!.textContent!);
  try {
    await act(async () => root.render(<WorkspaceLiveProvider clock={time.clock}><Subject /></WorkspaceLiveProvider>));
    assert.equal(reads, 1);
    assert.equal(shown().live, false);
    await act(async () => time.advance(15_000));
    assert.equal(reads, 2, "not live: the read polls at 15 s");

    // The stream fences the pool at the read's checkpoint and goes live. Going live reads nothing at once
    // (every tab would): the wait already running ends, then reads wait 30 s.
    await act(async () => {
      sources[0]!.emit("status", { state: "live", pool_key: POOL, checkpoint: 10, cursor: "10:0:0:0", provenance: wire(10) });
      sources[0]!.emit("hint", { type: "hello", provenance: wire(1) });
    });
    assert.equal(shown().live, true);
    assert.equal(reads, 2, "going live does not read at once");
    await act(async () => time.advance(15_000));
    assert.equal(reads, 3, "the wait started before going live ends");
    await act(async () => time.advance(15_000));
    assert.equal(reads, 3, "live: no read at 15 s");

    // A trade frame moves the candle and the header price with no read.
    await act(async () => sources[0]!.emit("market", trade(11)));
    assert.equal(reads, 3);
    assert.deepEqual(shown(), { live: true, close: "3", trades: 2, price: { usd: "10.3563", observedAt: NOW + 11, checkpoint: 11, paused: false } });
    await act(async () => time.advance(15_000));
    assert.equal(reads, 4, "live: the read polls at 30 s");
    assert.equal(shown().close, "3", "a read older than the trade keeps the trade on top");

    // A new chart window empties the read for a moment; the stream and the header price stay.
    await act(async () => setKey("coin:7d"));
    assert.equal(reads, 5);
    assert.equal(sources.length, 1, "no new connection");
    assert.deepEqual(shown(), { live: true, close: "3", trades: 2, price: { usd: "10.3563", observedAt: NOW + 11, checkpoint: 11, paused: false } });

    // The stream drops: the price and the streamed candle stay, the price marked paused, and reads go
    // back to 15 s after the running wait.
    checkpoint = 11;
    await act(async () => sources[0]!.emit("error"));
    assert.equal(shown().live, false);
    assert.equal(shown().price.paused, true);
    assert.equal(shown().close, "3", "the chart keeps its streamed candle while paused");
    assert.equal(reads, 5, "leaving live does not read at once");
    await act(async () => time.advance(30_000));
    assert.equal(reads, 6, "the 30 s wait running when the stream dropped ends");
    await act(async () => time.advance(15_000));
    assert.equal(reads, 7, "not live again: the read polls at 15 s");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a migrated coin's stream survives an empty read: its candle frames keep the last migration", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const time = handClock(NOW);
  const sources: Source[] = [];
  const hub = new MarketStreamHub({
    createSource: () => { const source = new Source(); sources.push(source); return source; },
    schedule: () => () => {},
    defer: queueMicrotask, settle: (run) => { run(); return () => {}; }, random: () => 0, visible: () => true, onVisibilityChange: () => () => {},
  });
  const venue = `cetus:0x${"33".repeat(32)}`;
  const migrated = history(10);
  const read = { "coin:24h": async () => ({ ...migrated, poolKey: venue, page: { ...migrated.page, migration: { cursor: "5:0:0:0", timestampMs: BUCKET - 120_000, curvePoolKey: POOL, venuePoolKey: venue } } }), "coin:7d": () => new Promise<never>(() => {}) };
  let setKey: (key: "coin:24h" | "coin:7d") => void = () => {};
  function Subject() {
    const [key, changeKey] = useState<"coin:24h" | "coin:7d">("coin:24h");
    setKey = changeKey;
    const base = useCoinRead(true, key, read[key], undefined, 15_000);
    const stream = useMarketStream(COIN, base.value, true, base.refresh, hub);
    return <output>{JSON.stringify({ live: stream.live, empty: base.value === null })}</output>;
  }
  const shown = () => JSON.parse(document.querySelector("output")!.textContent!);
  try {
    await act(async () => root.render(<WorkspaceLiveProvider clock={time.clock}><Subject /></WorkspaceLiveProvider>));
    await act(async () => {
      sources[0]!.emit("status", { state: "live", pool_key: venue, checkpoint: 10, cursor: "10:0:0:0", provenance: wire(10) });
      sources[0]!.emit("hint", { type: "hello", provenance: wire(1) });
    });
    await act(async () => setKey("coin:7d"));
    assert.deepEqual(shown(), { live: true, empty: true });
    const closed = { type: "candle_closed", cursor: "12:0:0:0", checkpoint: 12, timestamp_ms: NOW + 12, provenance: wire(12), pool_key: venue, interval: "1m", candle: { bucket_start: BUCKET - 60_000, interval: "1m", open: "2", high: "2", low: "2", close: "2", volume_quote: "5", volume_meme: "3", volume_usd: null, buys: 1, sells: 0, trades: 1 } };
    await act(async () => sources[0]!.emit("market", closed));
    assert.equal(shown().live, true, "the frame parses against the remembered migration; the stream stays up");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

