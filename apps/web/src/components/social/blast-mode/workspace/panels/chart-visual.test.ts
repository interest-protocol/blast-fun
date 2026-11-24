import assert from "node:assert/strict";
import test from "node:test";
import { chartVisual, axisPrice, priceTickLabels, chartTimeTicks, nearestObservation } from "./chart-visual";

test("close lines stop at missing buckets and at a source boundary", () => {
  const visual = chartVisual(
    [
      { at: 0, value: "1", source: "curve" },
      { at: 60_000, value: "2", source: "curve" },
      { at: 180_000, value: "3", source: "curve" },
      { at: 240_000, value: "4", source: "venue" },
      { at: 300_000, value: "5", source: "venue" },
    ],
    60_000,
  )!;
  assert.deepEqual(
    visual.segments.map((segment) => segment.length),
    [2, 1, 2],
  );
  assert.equal(visual.gaps.length, 1);
  assert.equal(visual.gaps[0], 120_000);
  assert.equal(nearestObservation(visual.points, 110_000), 1);
});

test("placement preserves very tiny native prices and never drops an extreme", () => {
  const visual = chartVisual(
    [
      { at: 1, value: "0." + "0".repeat(350) + "1", source: "curve" },
      { at: 2, value: "0." + "0".repeat(350) + "2", source: "curve" },
      { at: 3, value: "10000000000000000000000000000000000", source: "curve" },
    ],
    1,
  )!;
  assert.equal(visual.points.length, 3);
  assert.ok(
    visual.points.every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    ),
  );
  assert.equal(visual.ticks[0]!.value, "10000000000000000000000000000000000");
  assert.notEqual(axisPrice("0." + "0".repeat(350) + "1"), "0");
});

test("flat and single observations stay visible; empty data stays empty", () => {
  assert.equal(chartVisual([], 60_000), null);
  const visual = chartVisual(
    [{ at: 1000, value: "0.123456789", source: "indexed" }],
    60_000,
  )!;
  assert.equal(visual.points[0]!.y, 150);
  assert.equal(visual.points[0]!.value, "0.123456789");
  assert.notEqual(visual.ticks[0]!.value, visual.ticks.at(-1)!.value);
});

test("price ticks distinguish tiny moves beyond floating-point precision", () => {
  const visual = chartVisual([
    { at: 0, value: "1.00000000000000001", source: "indexed" },
    { at: 1, value: "1.00000000000000002", source: "indexed" },
  ], 1)!;
  const labels = priceTickLabels(visual.ticks.map(tick => tick.value));
  assert.equal(new Set(labels).size, 4);
  assert.equal(labels[0], "1.00000000000000002");
});

test("time ticks label the observed span and disambiguate dates across years", () => {
  const start = Date.UTC(2025, 11, 28);
  const end = Date.UTC(2026, 0, 4);
  const ticks = chartTimeTicks(start, end);
  assert.deepEqual(ticks.map(tick => tick.x), [0, 25, 50, 75, 100]);
  assert.equal(ticks[0]!.at, start);
  assert.equal(ticks.at(-1)!.at, end);
  assert.match(ticks[0]!.label, /25/);
  assert.match(ticks.at(-1)!.label, /26/);
  const day = chartTimeTicks(start, start + 86_400_000);
  assert.equal(new Set(day.map(tick => tick.label)).size, 5, "a 24h span includes time as well as date");
});

test("short native spans use distinct seconds and a single observation has one time tick", () => {
  const ticks = chartTimeTicks(0, 2_000);
  assert.equal(new Set(ticks.map(tick => tick.label)).size, 3);
  assert.equal(ticks[0]!.label, "00:00:00");
  assert.equal(ticks.at(-1)!.label, "00:00:02");
  assert.deepEqual(chartTimeTicks(0, 0), [{ at: 0, label: "00:00:00", x: 50 }]);
});
