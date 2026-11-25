import assert from "node:assert/strict";
import test from "node:test";

import type { Candle, MigratedChart, MigrationMarker, PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";

import { afterChartRead, candleGaps, chartRequest, chartSearch, initialChart, parseChartControls, preferredChartControls } from "./chart-model.ts";

import { chartPoolKeys } from "./chart-client.ts";

const NOW = 1_790_338_482_000;

test("a direct link's interval and range survive a refresh; anything else is the default", () => {
  assert.deepEqual(parseChartControls({ interval: "1h", range: "7d" }), { interval: "1h", range: "7d" });
  assert.deepEqual(parseChartControls({}), { interval: "5m", range: "all" });
  assert.deepEqual(parseChartControls({ interval: "2m", range: ["24h", "7d"] }), { interval: "5m", range: "all" });
  // 1s candles are built on request and never close live: not a chart control.
  assert.deepEqual(parseChartControls({ interval: "1s", range: "1h" }), { interval: "5m", range: "1h" });
  assert.equal(chartSearch({ interval: "15m", range: "24h" }), "?interval=15m&range=24h");
  assert.deepEqual(parseChartControls(Object.fromEntries(new URLSearchParams(chartSearch({ interval: "1d", range: "30d" })))), {
    interval: "1d",
    range: "30d",
  });
});

test("a saved chart range and interval fill in only missing or invalid link values", () => {
  const initial = parseChartControls({});
  const saved = chartSearch({ interval: "15m", range: "24h" });
  assert.deepEqual(preferredChartControls(saved, "", initial), { interval: "15m", range: "24h" });
  assert.deepEqual(preferredChartControls(saved, "?range=7d", initial), { interval: "1h", range: "7d" });
  assert.deepEqual(preferredChartControls(saved, "?interval=1h&range=all", initial), { interval: "1h", range: "all" });
  assert.deepEqual(preferredChartControls(saved, "?interval=2m&range=7d&range=all", initial), { interval: "15m", range: "24h" });
});

test("each range is one bounded page per source: whole candles from the range's first bucket", () => {
  // 24 h of 15m candles: 97 buckets at most, from the bucket that holds now − 24 h.
  const day = chartRequest({ interval: "15m", range: "24h" }, NOW);
  assert.deepEqual(day, { interval: "15m", from: NOW - 86_400_000 - ((NOW - 86_400_000) % 900_000), limit: 97, capped: false });
  // A range with more buckets than a page holds asks for the page's maximum, newest first.
  assert.deepEqual(chartRequest({ interval: "1m", range: "30d" }, NOW), {
    interval: "1m",
    from: NOW - 30 * 86_400_000 - ((NOW - 30 * 86_400_000) % 60_000),
    limit: 2000,
    capped: true,
  });
  // All history: the newest page, no lower bound.
  assert.deepEqual(chartRequest({ interval: "5m", range: "all" }, NOW), { interval: "5m", limit: 2000, capped: true });
});

test("a range of weekly candles starts at the Monday 00:00 UTC week that holds its start", () => {
  // NOW is Friday 2026-09-25; 30 days earlier is Wednesday 2026-08-26, in the week of Monday 2026-08-24.
  const month = chartRequest({ interval: "1w", range: "30d" }, NOW);
  assert.equal(month.from, Date.UTC(2026, 7, 24));
  assert.equal(new Date(month.from!).getUTCDay(), 1);
  // That week and the four after it, the last still open: the whole range fits one page.
  assert.equal(month.limit, 5);
  assert.equal(month.capped, false);
});

const T0 = 1_790_337_660_000;
const CURVE_KEY = `blast_curve:0x${"a1".repeat(32)}`;

function candle(bucketStart: number, open: string, close: string): Candle {
  const [low, high] = Number(open) <= Number(close) ? [open, close] : [close, open];
  return { bucketStart, open, high, low, close, volumeQuote: 1_000n, volumeMeme: 2_000n, volumeUsd: null, buys: 1, sells: 0, trades: 1 };
}

function page(candles: Candle[], poolKey = CURVE_KEY): PoolCandlePage {
  const venue = poolKey.split(":")[0] as PoolCandlePage["venue"];
  return { poolKey, source: venue === "blast_curve" ? "curve" : "venue", venue, interval: "1m", candles, migration: null };
}

test("an interval without trades is a gap between candles, never a candle", () => {
  const contiguous = page([candle(T0, "1", "2"), candle(T0 + 60_000, "2", "3")]);
  assert.deepEqual(candleGaps(contiguous), []);
  const gapped = page([candle(T0, "1", "2"), candle(T0 + 60_000, "2", "3"), candle(T0 + 240_000, "3", "1"), candle(T0 + 300_000, "1", "1")]);
  assert.deepEqual(candleGaps(gapped), [{ from: T0 + 120_000, to: T0 + 240_000, intervals: 2 }]);
  // The candles themselves are untouched.
  assert.equal(gapped.candles.length, 4);
});

const VENUE_KEY = `cetus:0x${"c3".repeat(32)}`;
const MIGRATION: MigrationMarker = { cursor: "22:2:2:0", timestampMs: T0 + 250_000, curvePoolKey: CURVE_KEY, venuePoolKey: VENUE_KEY };
test("a graduated range omits the curve only after the entire migration bucket", () => {
  const source = { curvePoolKey: CURVE_KEY, venuePoolKey: VENUE_KEY, migration: MIGRATION };
  const start = chartRequest({ interval: "5m", range: "24h" }, MIGRATION.timestampMs + 86_400_000);
  assert.deepEqual(chartPoolKeys(source, { interval: "5m", range: "24h" }, start.from! + 86_400_000 + 299_999), [CURVE_KEY, VENUE_KEY]);
  assert.deepEqual(chartPoolKeys(source, { interval: "5m", range: "24h" }, start.from! + 86_700_000), [VENUE_KEY]);
  assert.deepEqual(chartPoolKeys(source, { interval: "5m", range: "all" }, start.from! + 86_700_000), [CURVE_KEY, VENUE_KEY]);
  assert.deepEqual(chartPoolKeys(source, { interval: "1s", range: "live" }, start.from! + 86_700_000), [CURVE_KEY, VENUE_KEY]);
});

const PROVENANCE: Provenance = {
  source: "blast-infra",
  network: "localnet",
  deployment: "5d2f2a4b",
  checkpoint: 38,
  timestampMs: T0 + 400_000,
  observedAt: T0 + 400_400,
  lagMs: 400,
};
const migrated = (candles: Candle[], poolKey: string, migration: MigrationMarker | null = MIGRATION) => ({ ...page(candles, poolKey), migration });
const CURVE_PAGE = migrated([candle(T0, "1", "2"), candle(T0 + 240_000, "2", "3")], CURVE_KEY);
const VENUE_PAGE = migrated([candle(T0 + 240_000, "5", "6")], VENUE_KEY);
const answered = (data: PoolCandlePage) => ({ state: "available" as const, data, provenance: PROVENANCE });
const down = (reason: string) => ({ state: "unavailable" as const, reason, provenance: { ...PROVENANCE, reason } });

test("an outage keeps each source's last answer Stale with its own provenance, and never another range's", () => {
  const first: MigratedChart = { curve: answered(CURVE_PAGE), venue: answered(VENUE_PAGE), migration: MIGRATION };
  const shown = afterChartRead(initialChart("1m|all"), "1m|all", first, MIGRATION);
  assert.equal(shown.curve.state, "available");
  assert.equal(shown.venue?.state, "available");

  // The venue goes down: the curve stays current, the venue keeps its last candles, Stale.
  const venueDown = afterChartRead(shown, "1m|all", { ...first, venue: down("not_ready") }, MIGRATION);
  assert.equal(venueDown.curve.state, "available");
  assert.deepEqual(venueDown.venue, { state: "stale", data: VENUE_PAGE, provenance: PROVENANCE, reason: "not_ready" });

  // A controls change starts over, so another interval never shows this one's candles, even through an outage.
  const other = afterChartRead(initialChart("5m|all", true, venueDown.migration), "5m|all", { curve: down("unreachable"), venue: down("unreachable"), migration: null }, MIGRATION);
  assert.equal(other.curve.state, "unavailable");
  assert.equal(other.venue?.state, "unavailable");
  assert.deepEqual(other.migration, MIGRATION, "the committed migration stays marked");
});

test("a read for other controls that answers last never replaces the chart shown for the current ones", () => {
  const minutes: MigratedChart = { curve: answered(CURVE_PAGE), venue: answered(VENUE_PAGE), migration: MIGRATION };
  const hours: MigratedChart = {
    curve: answered({ ...CURVE_PAGE, interval: "1h", candles: [candle(T0, "1", "3")] }),
    venue: answered({ ...VENUE_PAGE, interval: "1h", candles: [candle(T0, "5", "6")] }),
    migration: MIGRATION,
  };
  // The viewer switched from 1m to 1h and the 1h read answered...
  const shown = afterChartRead(initialChart("1h|all", true, MIGRATION), "1h|all", hours, MIGRATION);
  // ...then a live re-read that still read 1m answers last: the 1h chart stays.
  const late = afterChartRead(shown, "1m|all", minutes, MIGRATION);
  assert.equal(late.key, "1h|all");
  assert.equal(late.curve.state === "available" && late.curve.data.interval, "1h");
  assert.deepEqual(late, shown);
  // Before the 1h read answers, a 1m answer leaves it loading rather than showing 1m candles.
  const pending = initialChart("1h|all", true, MIGRATION);
  assert.deepEqual(afterChartRead(pending, "1m|all", minutes, MIGRATION), pending);
});

test("the marker is the committed migration; a page about another migration is not this launch's chart", () => {
  const elsewhere = migrated([candle(T0 + 240_000, "5", "6")], VENUE_KEY, { ...MIGRATION, cursor: "23:0:0:0" });
  const chart: MigratedChart = { curve: answered(CURVE_PAGE), venue: answered(elsewhere), migration: MIGRATION };
  const state = afterChartRead(initialChart("1m|all"), "1m|all", chart, MIGRATION);
  assert.equal(state.curve.state, "available");
  assert.equal(state.venue?.state === "unavailable" && state.venue.reason, "route-mismatch");

  // Before the summary knows of a migration, the curve's committed marker is the one shown.
  const learned = afterChartRead(initialChart("1m|all"), "1m|all", { curve: answered(CURVE_PAGE), venue: null, migration: MIGRATION }, null);
  assert.deepEqual(learned.migration, MIGRATION);
  assert.equal(learned.venue, null);
});
