import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import {
  parsePoolCandlePage,
  parsePoolTradesPage,
  poolCandlesPath,
  poolTradesPath,
  readMigratedChart,
  readPoolCandles,
  readPoolTrades,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";

const ORIGIN = "https://api.blast.test";
const captured = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../test/fixtures/modules/launchpad-contract/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * The captures are blast-infra's venue fixture at `lst/T-026-1`: coin c migrated into Cetus CLMM
 * (meme as coin B), coin d into Bluefin Spot (meme as coin A). Each candle page is one pool's 1m
 * chart and names the migration that bounds it.
 */
const CETUS = captured("v1-pool-candles-cetus.json");
const BLUEFIN = captured("v1-pool-candles-bluefin.json");
const CURVE = captured("v1-pool-candles-curve.json");
const marker = (body: Record<string, unknown>) => body.migration as Record<string, string | number>;
const CETUS_KEY = marker(CETUS).venue_pool_key as string;
const BLUEFIN_KEY = marker(BLUEFIN).venue_pool_key as string;
const CURVE_KEY = marker(CETUS).curve_pool_key as string;

type Candle = Record<string, unknown>;
const candlesOf = (body: Record<string, unknown>) => structuredClone(body.candles) as Candle[];
const withCandles = (body: Record<string, unknown>, candles: Candle[]) => ({ ...structuredClone(body), candles });

/** The capture as served fresh: observed 400 ms after its checkpoint. */
function fresh(body: Record<string, unknown>): Record<string, unknown> {
  const provenance = body.provenance as Record<string, number>;
  return { ...body, provenance: { ...provenance, observed_ms: provenance.timestamp_ms + 400, lag_ms: 400 } };
}

function blastInfra(reply: (path: string) => Response | Promise<Response>, seen: string[] = []): MarketDataDependencies {
  const provenance = fresh(CETUS).provenance as Record<string, number>;
  return {
    origin: ORIGIN,
    now: () => provenance.timestamp_ms + 400,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: async (input: string | URL | Request) => {
      const path = String(input).slice(ORIGIN.length);
      if (path === "/v1/status") return Response.json({ provenance });
      seen.push(path);
      return reply(path);
    },
  };
}

test("each venue's captured chart parses as its own source, bounded by its migration", () => {
  assert.match(CETUS_KEY, /^cetus:0x[0-9a-f]{64}$/);
  assert.match(BLUEFIN_KEY, /^bluefin:0x[0-9a-f]{64}$/);
  for (const [key, body] of [
    [CETUS_KEY, CETUS],
    [BLUEFIN_KEY, BLUEFIN],
  ] as const) {
    const page = parsePoolCandlePage(key, "1m", body);
    assert.equal(page.source, "venue");
    assert.equal(page.venue, key.split(":")[0]);
    assert.equal(page.migration?.venuePoolKey, key);
    assert.ok(page.candles.length > 1);
    assert.ok(page.candles.every((candle) => candle.bucketStart + 60_000 > page.migration!.timestampMs));
    page.candles.slice(1).forEach((candle, index) => assert.equal(candle.open, page.candles[index].close));
  }
  const curve = parsePoolCandlePage(CURVE_KEY, "1m", CURVE);
  assert.equal(curve.source, "curve");
  assert.equal(curve.venue, "blast_curve");
  assert.deepEqual(curve.migration, parsePoolCandlePage(CETUS_KEY, "1m", CETUS).migration);
  assert.ok(curve.candles.every((candle) => candle.bucketStart <= curve.migration!.timestampMs));
  // Exact values stay exact.
  const first = (CETUS.candles as Candle[])[0];
  const parsed = parsePoolCandlePage(CETUS_KEY, "1m", CETUS).candles[0];
  assert.equal(parsed.volumeQuote, BigInt(first.volume_quote as string));
  assert.equal(parsed.open, first.open);
});

test("a chart that conceals the migration, mixes sources or fills a gap is refused", () => {
  const refuses = (key: string, body: unknown, field: RegExp) =>
    assert.throws(
      () => parsePoolCandlePage(key, "1m", body),
      (error: unknown) => error instanceof ContractViolation && field.test(error.field),
    );
  const candles = candlesOf(CETUS);
  // An open that is not the previous close, and an interval without trades.
  refuses(CETUS_KEY, withCandles(CETUS, candles.map((c, i) => (i === 1 ? { ...c, open: "1" } : c))), /candles\[1\]/);
  refuses(
    CETUS_KEY,
    withCandles(CETUS, [...candles, { ...candles.at(-1)!, bucket_start: (candles.at(-1)!.bucket_start as number) + 60_000, trades: 0, buys: 0, sells: 0 }]),
    /candles\[\d+\]/,
  );
  // Out of order, off the interval's grid, or of another interval.
  refuses(CETUS_KEY, withCandles(CETUS, [...candles].reverse()), /candles\[\d+\]/);
  refuses(CETUS_KEY, withCandles(CETUS, [{ ...candles[0], bucket_start: (candles[0].bucket_start as number) + 1 }]), /candles\[0\]/);
  refuses(CETUS_KEY, { ...CETUS, interval: "5m" }, /interval/);
  // A venue candle wholly before its migration, and a curve candle after it.
  const at = marker(CETUS).timestamp_ms as number;
  const early = at - (at % 60_000) - 60_000;
  refuses(CETUS_KEY, withCandles(CETUS, [{ ...candles[0], bucket_start: early }]), /candles\[0\]/);
  const curve = candlesOf(CURVE);
  refuses(CURVE_KEY, withCandles(CURVE, [...curve, { ...curve.at(-1)!, bucket_start: at - (at % 60_000) + 60_000, open: curve.at(-1)!.close }]), /candles\[\d+\]/);
  // A venue page naming another pool, and a page of another pool's chart.
  refuses(BLUEFIN_KEY, CETUS, /migration/);
  refuses(CURVE_KEY, BLUEFIN, /migration/);
  refuses(CETUS_KEY, { ...CETUS, extra: 1 }, /extra/);
});

test("the pool reader accepts legacy candles and empty legacy pages without a migration", async () => {
  const poolKey = "cetus:0x0e40203fe4290967117b69be99785dd3a4798bc92e5ec460177f842309430a0d";
  const candle = {
    bucket_start: 1_795_305_600_000, interval: "1m", open: "1", high: "1", low: "0.25", close: "0.25",
    volume_quote: "17", volume_meme: "23", volume_usd: null, buys: 0, sells: 1, trades: 1,
  };
  const read = (candles: readonly unknown[]) => readPoolCandles(poolKey, { interval: "1m" },
    blastInfra(() => Response.json(fresh({ ...CETUS, migration: null, candles }))));
  const populated = await read([candle]);
  assert.equal(populated.status, "fresh");
  assert.equal(populated.data.kind, "answer");
  assert.equal(populated.data.value.candles[0].close, "0.25");
  assert.equal(populated.data.value.candles[0].volumeQuote, 17n);
  assert.equal(populated.data.value.migration, null);
  const empty = await read([]);
  assert.equal(empty.status, "fresh");
  assert.equal(empty.data.kind, "answer");
  assert.deepEqual(empty.data.value.candles, []);
  assert.throws(() => parsePoolCandlePage(poolKey, "1m", CETUS), ContractViolation);
});

test("a pool no curve fed, such as a graduated presale's, reads its swaps without a migration", () => {
  const candles = candlesOf(CETUS);
  const page = parsePoolCandlePage(CETUS_KEY, "1m", { ...CETUS, migration: null });
  assert.equal(page.migration, null);
  assert.equal(page.source, "venue");
  assert.equal(page.candles.length, candles.length);
});

test("the JustOneSui candle feed accepts an empty page before the first swap", () => {
  const poolKey = "cetus:0x1f30ac740fec626467ac825121314185a9a2feacd88185d70cea7e092d07fd3a";
  const page = parsePoolCandlePage(poolKey, "1m", { interval: "1m", candles: [], migration: null });
  assert.deepEqual(page.candles, []);
  assert.equal(page.migration, null);
});

test("candle and trade paths are bounded and refuse what blast-infra would", () => {
  assert.equal(
    poolCandlesPath(CETUS_KEY, { interval: "1m", to: 1_790_000_000_000, limit: 300 }),
    `/v1/pools/cetus/${CETUS_KEY.slice(6)}/candles?interval=1m&limit=300&to=1790000000000`,
  );
  assert.equal(
    poolCandlesPath(CURVE_KEY, { interval: "1d", from: 5 }),
    `/v1/pools/blast_curve/${CURVE_KEY.slice(12)}/candles?interval=1d&limit=500&from=5`,
  );
  assert.throws(() => poolCandlesPath(CETUS_KEY, { interval: "2m" as "1m" }), CursorError);
  assert.throws(() => poolCandlesPath(CETUS_KEY, { interval: "1m", limit: 2001 }), CursorError);
  assert.throws(() => poolCandlesPath(CETUS_KEY, { interval: "1m", from: 10, to: 10 }), CursorError);
  assert.throws(() => poolCandlesPath("uniswap:0x1", { interval: "1m" }), CursorError);
  assert.equal(poolTradesPath(BLUEFIN_KEY, { before: "3:1:0:0", limit: 2 }), `/v1/pools/bluefin/${BLUEFIN_KEY.slice(8)}/trades?limit=2&before=3%3A1%3A0%3A0`);
  assert.throws(() => poolTradesPath(BLUEFIN_KEY, { limit: 201 }), CursorError);
  assert.throws(() => poolTradesPath(BLUEFIN_KEY, { before: "3:1" }), CursorError);
});

test("venue activity is the pool's own completed swaps, newest first, with its recorded whale fact", () => {
  for (const [key, name] of [
    [CETUS_KEY, "v1-pool-trades-cetus.json"],
    [BLUEFIN_KEY, "v1-pool-trades-bluefin.json"],
  ] as const) {
    const body = captured(name);
    const page = parsePoolTradesPage(key, body);
    assert.equal(page.trades.length, (body.trades as unknown[]).length);
    assert.ok(page.trades.every((trade) => trade.kind === "swap" && trade.venueSwap !== null));
    const raw = body.trades as { labels: string[] }[];
    assert.deepEqual(page.trades.map((trade) => trade.whale === true), raw.map((trade) => trade.labels.includes("whale")));
    assert.ok(page.trades.some((trade) => trade.side === "buy") && page.trades.some((trade) => trade.side === "sell"));
    const trades = body.trades as Record<string, unknown>[];
    const refuses = (changed: unknown, field: RegExp) =>
      assert.throws(
        () => parsePoolTradesPage(key, changed),
        (error: unknown) => error instanceof ContractViolation && field.test(error.field),
      );
    refuses({ ...body, trades: [{ ...trades[0], pool_key: CURVE_KEY }] }, /trades\[0\]\.pool_key/);
    refuses({ ...body, trades: [{ ...trades[0], kind: "buy", venue_swap: null }] }, /trades\[0\]/);
    refuses({ ...body, trades: [...trades].reverse() }, /trades\[\d+\]\.cursor/);
  }
});

test("a Cetus swap keeps its own USD cap while a missing rate leaves its price usable", () => {
  const trade = (captured("v1-pool-trades-cetus.json").trades as Record<string, unknown>[])[0];
  const usd = { price: "64500000", expo: -8, publish_time: 1, age_ms: 0 };
  const read = (over: Record<string, unknown>) => parsePoolTradesPage(CETUS_KEY, { trades: [{
    ...trade, inputs: { quote_decimals: "9" }, market_cap: "57000000000001", usd, ...over,
  }] }).trades[0];
  assert.equal(read({}).marketCapUsd, "36765.00000000064500000");
  assert.equal(read({ market_cap: "0" }).marketCapUsd, "0.00000000000000000");
  for (const over of [{ usd: null }, { inputs: null }, { inputs: { quote_decimals: "256" } }, { market_cap: "invalid" }]) {
    const result = read(over);
    assert.equal(result.marketCapUsd, null);
    assert.equal(result.price, trade.price);
  }
});

test("a venue outage leaves the curve's chart and the migration readable, and the venue unavailable", async () => {
  const route = { curvePoolKey: CURVE_KEY, venuePoolKey: CETUS_KEY };
  const seen: string[] = [];
  const chart = await readMigratedChart(
    route,
    { interval: "1m" },
    blastInfra((path) =>
      path.includes("/cetus/")
        ? Response.json({ error: { code: "not_ready", message: "candle history is unavailable" } }, { status: 503, headers: { "Retry-After": "1" } })
        : Response.json(fresh(CURVE)),
    seen),
  );
  assert.equal(chart.curve.state, "available");
  assert.equal(chart.venue?.state, "unavailable");
  assert.equal(chart.migration?.venuePoolKey, CETUS_KEY);
  assert.equal(seen.length, 2);

  // Both answer: two separate series and one marker.
  const both = await readMigratedChart(route, { interval: "1m" }, blastInfra((path) => Response.json(fresh(path.includes("/cetus/") ? CETUS : CURVE))));
  assert.equal(both.curve.state, "available");
  assert.equal(both.venue?.state, "available");
  if (both.venue?.state === "available") assert.equal(both.venue.data.source, "venue");

  // A venue answer about another route is no chart of this launch.
  const wrong = await readMigratedChart(route, { interval: "1m" }, blastInfra((path) => Response.json(fresh(path.includes("/cetus/") ? BLUEFIN : CURVE))));
  assert.equal(wrong.venue?.state, "unavailable");
  assert.equal(wrong.curve.state, "available");

  // Before migration there is no venue source to read.
  const before = await readMigratedChart({ curvePoolKey: CURVE_KEY, venuePoolKey: null }, { interval: "1m" }, blastInfra(() => Response.json(fresh({ ...CURVE, migration: null }))));
  assert.equal(before.venue, null);
  assert.equal(before.migration, null);
});

test("venue trades are read through the routed market read", async () => {
  const read = await readPoolTrades(CETUS_KEY, { limit: 50 }, blastInfra(() => Response.json(fresh(captured("v1-pool-trades-cetus.json")))));
  assert.notEqual(read.status, "unavailable");
  if (read.status !== "unavailable" && read.data.kind === "answer") assert.ok(read.data.value.trades.length > 0);
});

test("a venue page about another migration of its pool is a route mismatch, and a curve outage keeps the venue", async () => {
  const route = { curvePoolKey: CURVE_KEY, venuePoolKey: CETUS_KEY };
  const notReady = () =>
    Response.json({ error: { code: "not_ready", message: "candle history is unavailable" } }, { status: 503, headers: { "Retry-After": "1" } });
  // The venue's page parses (it names its own pool) but its migration differs from the curve's.
  for (const changed of [{ cursor: "1:1:1:0" }, { timestamp_ms: (marker(CETUS).timestamp_ms as number) + 1 }]) {
    const other = { ...CETUS, migration: { ...marker(CETUS), ...changed } };
    const chart = await readMigratedChart(route, { interval: "1m" }, blastInfra((path) => Response.json(fresh(path.includes("/cetus/") ? other : CURVE))));
    assert.equal(chart.curve.state, "available");
    assert.deepEqual(chart.venue?.state === "unavailable" && chart.venue.reason, "route-mismatch");
    assert.equal(chart.migration?.cursor, marker(CURVE).cursor, "the curve's marker stands");
  }
  // A curve's venue page that names no migration is not that curve's chart, with the curve up or down.
  const unmarked = { ...CETUS, migration: null };
  for (const curve of [() => Response.json(fresh(CURVE)), notReady]) {
    const chart = await readMigratedChart(route, { interval: "1m" }, blastInfra((path) => (path.includes("/cetus/") ? Response.json(fresh(unmarked)) : curve())));
    assert.deepEqual(chart.venue?.state === "unavailable" && chart.venue.reason, "route-mismatch");
  }
  // The reverse outage: the curve is down, the venue answers and names the route's curve.
  const reverse = await readMigratedChart(route, { interval: "1m" }, blastInfra((path) => (path.includes("/cetus/") ? Response.json(fresh(CETUS)) : notReady())));
  assert.equal(reverse.curve.state, "unavailable");
  assert.equal(reverse.venue?.state, "available");
  assert.deepEqual(reverse.migration, parsePoolCandlePage(CETUS_KEY, "1m", CETUS).migration);
  // With the curve down, a venue naming another curve is no chart of this launch.
  const foreign = { ...CETUS, migration: { ...marker(CETUS), curve_pool_key: marker(BLUEFIN).curve_pool_key } };
  const off = await readMigratedChart(route, { interval: "1m" }, blastInfra((path) => (path.includes("/cetus/") ? Response.json(fresh(foreign)) : notReady())));
  assert.equal(off.venue?.state, "unavailable");
  assert.equal(off.migration, null);
});

test("a chart route names a curve and a venue pool, or it is refused before any read", async () => {
  const seen: string[] = [];
  const reply = blastInfra(() => Response.json(fresh(CURVE)), seen);
  await assert.rejects(readMigratedChart({ curvePoolKey: CETUS_KEY, venuePoolKey: CETUS_KEY }, { interval: "1m" }, reply), CursorError);
  await assert.rejects(readMigratedChart({ curvePoolKey: CURVE_KEY, venuePoolKey: CURVE_KEY }, { interval: "1m" }, reply), CursorError);
  assert.deepEqual(seen, []);
});
