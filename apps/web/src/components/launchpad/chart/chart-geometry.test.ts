import assert from "node:assert/strict";
import test from "node:test";

import { candleFixtureBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/chart-fixtures.ts";
import { CURVE_POOL_KEY, VENUE_POOL_KEY } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { parsePoolCandlePage, type Candle, type CandleInterval, type MigrationMarker, type PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";

import { CHART_HEIGHT, CHART_WIDTH, PANES, chartGeometry, type ChartGeometry, type DrawnCandle } from "./chart-geometry.ts";

const MINUTE = 60_000;
/** 2026-09-25 12:00:00 UTC. */
const T0 = 1_790_337_600_000;
const CURVE_KEY = `blast_curve:0x${"a1".repeat(32)}`;
const VENUE_KEY = `cetus:0x${"c3".repeat(32)}`;
/** Committed 19 s into minute 5. */
const MIGRATION: MigrationMarker = { cursor: "22:2:2:0", timestampMs: T0 + 5 * MINUTE + 19_000, curvePoolKey: CURVE_KEY, venuePoolKey: VENUE_KEY };

function candle(
  minute: number,
  open: string,
  close: string,
  high = Number(open) >= Number(close) ? open : close,
  low = Number(open) <= Number(close) ? open : close,
  volumeQuote = 1_000n,
): Candle {
  return { bucketStart: T0 + minute * MINUTE, open, high, low, close, volumeQuote, volumeMeme: 1n, volumeUsd: null, buys: 1, sells: 0, trades: 1 };
}

function page(poolKey: string, candles: Candle[], migration: MigrationMarker | null = MIGRATION, interval: CandleInterval = "1m"): PoolCandlePage {
  const venue = poolKey.split(":")[0] as PoolCandlePage["venue"];
  return { poolKey, source: venue === "blast_curve" ? "curve" : "venue", venue, interval, candles, migration };
}

/** Where a time falls on the drawn axis, from the geometry's own range. */
const xAt = (geometry: ChartGeometry, time: number) => ((time - geometry.start) / (geometry.end - geometry.start)) * CHART_WIDTH;
const at = (geometry: ChartGeometry, source: "curve" | "venue", minute: number) =>
  geometry.candles.find((drawn) => drawn.source === source && drawn.candle.bucketStart === T0 + minute * MINUTE)!;
const EPSILON = 1e-9;

test("a higher price is drawn higher: the highest high tops the price pane, the lowest low ends it, and each body sits on its wick", () => {
  const curve = page(CURVE_KEY, [candle(0, "1", "2", "2.5", "0.5"), candle(1, "2", "1.5"), candle(3, "1.5", "3", "4", "1.5")], null);
  const geometry = chartGeometry([{ source: "curve", page: curve }], null, undefined, null)!;
  assert.equal(geometry.highest, "4");
  assert.equal(geometry.lowest, "0.5");
  assert.equal(at(geometry, "curve", 3).highY, PANES.priceTop, "the highest high is at the top");
  assert.equal(at(geometry, "curve", 0).lowY, PANES.priceBottom, "the lowest low is at the bottom");
  // 2 (minute 0's close) is drawn above 1 (its open), so a rising body's top is its close.
  const rising = at(geometry, "curve", 0);
  assert.equal(rising.direction, "up");
  assert.ok(rising.bodyTop < rising.bodyTop + rising.bodyHeight);
  assert.equal(at(geometry, "curve", 1).direction, "down");
  for (const drawn of geometry.candles) {
    assert.ok(drawn.highY <= drawn.bodyTop + EPSILON, "the wick reaches the high above the body");
    assert.ok(drawn.bodyTop + drawn.bodyHeight <= drawn.lowY + 1 + EPSILON, "the body ends at or above the low");
    assert.ok(drawn.highY >= PANES.priceTop - EPSILON && drawn.lowY <= PANES.priceBottom + EPSILON);
  }
});

test("each candle is drawn inside its own bucket, its volume below its price, and a gap spans exactly its missing intervals", () => {
  const curve = page(CURVE_KEY, [candle(0, "1", "2", "2", "1", 500n), candle(1, "2", "3", "3", "2", 2_000n), candle(4, "3", "2", "3", "2", 1_000n)], null);
  const geometry = chartGeometry([{ source: "curve", page: curve }], null, undefined, null)!;
  // All history runs from the first candle's bucket to the last one's end.
  assert.equal(geometry.start, T0);
  assert.equal(geometry.end, T0 + 5 * MINUTE);
  for (const drawn of geometry.candles) {
    const [left, right] = [xAt(geometry, drawn.candle.bucketStart), xAt(geometry, drawn.candle.bucketStart + MINUTE)];
    assert.ok(drawn.x >= left - EPSILON && drawn.x + drawn.width <= right + EPSILON, `minute ${(drawn.candle.bucketStart - T0) / MINUTE} is in its bucket`);
    assert.ok(drawn.wickX > drawn.x && drawn.wickX < drawn.x + drawn.width);
    assert.ok(drawn.volumeTop >= PANES.volumeTop - EPSILON && drawn.volumeTop <= PANES.volumeBottom);
  }
  // The largest volume is the tallest bar.
  assert.equal(at(geometry, "curve", 1).volumeTop, PANES.volumeTop);
  assert.ok(at(geometry, "curve", 0).volumeTop > at(geometry, "curve", 4).volumeTop);
  // Minutes 2 and 3 had no trades: one gap from the end of minute 1 to the start of minute 4, drawn as that span.
  assert.equal(geometry.gaps.length, 1);
  const [gap] = geometry.gaps;
  assert.deepEqual(gap.gap, { from: T0 + 2 * MINUTE, to: T0 + 4 * MINUTE, intervals: 2 });
  assert.ok(Math.abs(gap.x - 400) < EPSILON && Math.abs(gap.width - 400) < EPSILON, `gap drawn at ${gap.x} + ${gap.width}`);
  assert.ok(geometry.candles.every((drawn) => drawn.x + drawn.width <= gap.x + EPSILON || drawn.x >= gap.x + gap.width - EPSILON), "no candle in the gap");
});

/** The curve's marks end at or before the marker, the venue's start at or after it; no candle crosses it. */
function assertSides(geometry: ChartGeometry, label: string) {
  const marker = geometry.migrationX!;
  const reach = (drawn: DrawnCandle) => [Math.min(drawn.x, drawn.wickX), Math.max(drawn.x + drawn.width, drawn.wickX, drawn.closeTickEnd)];
  for (const drawn of geometry.candles) {
    const [left, right] = reach(drawn);
    if (drawn.source === "curve") assert.ok(right <= marker + EPSILON, `${label}: curve ${new Date(drawn.candle.bucketStart).toISOString()} ends at ${right}, past the marker at ${marker}`);
    else assert.ok(left >= marker - EPSILON, `${label}: venue ${new Date(drawn.candle.bucketStart).toISOString()} starts at ${left}, before the marker at ${marker}`);
  }
}

test("in the migration's bucket the curve is drawn before the marker and the venue after it, at every interval", () => {
  const now = 1_790_400_000_000;
  for (const interval of ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const) {
    const curve = parsePoolCandlePage(CURVE_POOL_KEY, interval, candleFixtureBody("curve", "migrated", { interval }, now));
    const venue = parsePoolCandlePage(VENUE_POOL_KEY, interval, candleFixtureBody("venue", "migrated", { interval }, now));
    const geometry = chartGeometry([{ source: "curve", page: curve }, { source: "venue", page: venue }], curve.migration, undefined, null)!;
    // The marker is at the committed time: 2026-09-24 06:06:40 UTC.
    assert.equal(curve.migration?.timestampMs, 1_790_230_000_000);
    assert.equal(geometry.migrationX, xAt(geometry, 1_790_230_000_000), interval);
    assertSides(geometry, interval);
  }
});

test("a migration bucket only one source traded in still keeps that source on its side of the marker", () => {
  // The curve traded in minute 5 (the migration's) and the venue first in minute 6.
  const curveOnly = chartGeometry(
    [
      { source: "curve", page: page(CURVE_KEY, [candle(0, "1", "2"), candle(5, "2", "3")]) },
      { source: "venue", page: page(VENUE_KEY, [candle(6, "5", "4")]) },
    ],
    MIGRATION,
    undefined,
    null,
  )!;
  assertSides(curveOnly, "curve only");
  // The venue traded in minute 5 and the curve last in minute 4.
  const venueOnly = chartGeometry(
    [
      { source: "curve", page: page(CURVE_KEY, [candle(0, "1", "2"), candle(4, "2", "3")]) },
      { source: "venue", page: page(VENUE_KEY, [candle(5, "5", "4"), candle(6, "4", "4.5")]) },
    ],
    MIGRATION,
    undefined,
    null,
  )!;
  assertSides(venueOnly, "venue only");
  // A migration committed at its bucket's start leaves the curve's candle in it a sliver before the marker.
  const atStart = { ...MIGRATION, timestampMs: T0 + 5 * MINUTE };
  const sliver = chartGeometry(
    [
      { source: "curve", page: page(CURVE_KEY, [candle(4, "1", "2"), candle(5, "2", "3")], atStart) },
      { source: "venue", page: page(VENUE_KEY, [candle(5, "5", "4")], atStart) },
    ],
    atStart,
    undefined,
    null,
  )!;
  assertSides(sliver, "at the bucket start");
});

test("the marker is at the committed time inside the drawn range, and absent outside it", () => {
  const curve = page(CURVE_KEY, [candle(0, "1", "2"), candle(5, "2", "3")]);
  const venue = page(VENUE_KEY, [candle(5, "5", "4"), candle(9, "4", "4")]);
  const both = chartGeometry([{ source: "curve", page: curve }, { source: "venue", page: venue }], MIGRATION, undefined, null)!;
  // All history: minute 0 to the end of minute 9, so 5 min 19 s is 531.67 of 1,000.
  assert.equal(both.start, T0);
  assert.equal(both.end, T0 + 10 * MINUTE);
  assert.ok(Math.abs(both.migrationX! - (319 / 600) * CHART_WIDTH) < EPSILON);
  // A range that starts after the migration does not draw it.
  const after = chartGeometry([{ source: "venue", page: page(VENUE_KEY, [candle(9, "4", "4")]) }], MIGRATION, T0 + 8 * MINUTE, T0 + 12 * MINUTE)!;
  assert.equal(after.start, T0 + 8 * MINUTE);
  assert.equal(after.migrationX, null);
  // Nor one that ends before it.
  const before = chartGeometry([{ source: "curve", page: page(CURVE_KEY, [candle(0, "1", "2")]) }], MIGRATION, undefined, null)!;
  assert.equal(before.end, T0 + MINUTE);
  assert.equal(before.migrationX, null);
});

test("the All range starts on the launch's bucket, so a first trade in a later bucket keeps the timeline on the bucket grid", () => {
  // Launched at 12:00:30; the first trades land at 12:07 (bucket 12:05) and 12:12 (bucket 12:10).
  const curve = page(CURVE_KEY, [candle(5, "1", "2"), candle(10, "2", "3")], null, "5m");
  const geometry = chartGeometry([{ source: "curve", page: curve, opening: { timestampMs: T0 + 30_000, price: "1" } }], null, undefined, null)!;
  assert.equal(geometry.start, T0);
});

test("a tick on each candle's right marks its close, so direction does not rest on colour", () => {
  const curve = page(CURVE_KEY, [candle(0, "1", "3"), candle(1, "3", "2"), candle(2, "2", "2")], null);
  const geometry = chartGeometry([{ source: "curve", page: curve }], null, undefined, null)!;
  const [rise, fall, flat] = [0, 1, 2].map((minute) => at(geometry, "curve", minute));
  // A rise closes at the body's top, a fall at its bottom.
  assert.equal(rise.closeY, rise.bodyTop);
  assert.equal(fall.closeY, fall.bodyTop + fall.bodyHeight);
  assert.ok(rise.closeY < fall.closeY);
  assert.equal(flat.closeY, flat.bodyTop);
  for (const drawn of geometry.candles) {
    // The tick leaves the body's right edge and stays in the candle's bucket.
    assert.ok(drawn.closeTickEnd > drawn.x + drawn.width, "the tick is drawn");
    assert.ok(drawn.closeTickEnd <= xAt(geometry, drawn.candle.bucketStart + MINUTE) + EPSILON, "the tick stays in its bucket");
  }
});

test("the marker's label has a band of its own above every candle, so it never covers one", () => {
  // The label is 2 px from the canvas top and 16 px tall (Chart.module.css); the smallest canvas is 200 px tall.
  assert.ok((PANES.labelBand / CHART_HEIGHT) * 200 >= 18, "the band holds the label on the smallest canvas");
  const curve = page(CURVE_KEY, [candle(0, "1", "9"), candle(5, "9", "3")]);
  const venue = page(VENUE_KEY, [candle(5, "12", "11"), candle(6, "11", "12")]);
  const geometry = chartGeometry([{ source: "curve", page: curve }, { source: "venue", page: venue }], MIGRATION, undefined, null)!;
  for (const drawn of geometry.candles) assert.ok(drawn.highY > PANES.labelBand, "no wick reaches the label band");
  assert.ok(geometry.gaps.length > 0);
  // Gap hatching starts at the price pane, below the band.
  assert.ok(PANES.priceTop > PANES.labelBand);
});

test("direction is the exact price order, as in the table: an unchanged candle is flat, with a level tick on both sides", () => {
  const tiny = "1.000000000000000000000000000000000001";
  const curve = page(CURVE_KEY, [candle(0, "1", "3"), candle(1, "3", "2"), candle(2, "2", "2"), candle(3, tiny, "1", tiny, "1")], null);
  const geometry = chartGeometry([{ source: "curve", page: curve }], null, undefined, null)!;
  const drawn = [0, 1, 2, 3].map((minute) => at(geometry, "curve", minute));
  // A fall smaller than a double resolves is still a fall.
  assert.deepEqual(drawn.map((candle) => candle.direction), ["up", "down", "flat", "down"]);
  const flat = drawn[2]!;
  // The flat candle's open tick leaves the body's left edge at the close's level, inside its bucket.
  assert.equal(flat.closeY, flat.bodyTop);
  assert.ok(flat.openTickStart !== null && flat.openTickStart < flat.x, "the open tick is drawn");
  assert.ok(flat.openTickStart! >= xAt(geometry, flat.candle.bucketStart) - EPSILON, "the open tick stays in its bucket");
  for (const moved of [drawn[0]!, drawn[1]!, drawn[3]!]) assert.equal(moved.openTickStart, null);
});
