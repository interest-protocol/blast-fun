import assert from "node:assert/strict";
import test from "node:test";
import { chartVisual } from "./chart-visual";
import {
  projectChartTime,
  tradingViewPriceLabel,
  tradingViewTimeline,
  restoredChartRange,
} from "./tradingview-data";

test("live refresh fits untouched views, follows the live edge, and preserves historical zoom", () => {
  const full = { range: { from: 100, to: 200 }, first: 100, last: 200 };
  assert.equal(
    restoredChartRange(full, 210),
    null,
    "append stays fully visible",
  );
  assert.equal(
    restoredChartRange({ ...full, first: 110 }, 210),
    null,
    "rolling start stays fully visible",
  );
  assert.deepEqual(
    restoredChartRange({ ...full, range: { from: 170, to: 200 } }, 210),
    { from: 180, to: 210 },
  );
  assert.deepEqual(
    restoredChartRange({ ...full, range: { from: 120, to: 150 } }, 210),
    { from: 120, to: 150 },
  );
});

test("flat prices retain a padded scale with distinct labels", () => {
  const visual = chartVisual(
    [{ at: 1000, value: "0.00000000000000000001", source: "curve" }],
    1000,
  )!;
  const labels = [30, 90, 150, 210, 270].map((coordinate) =>
    tradingViewPriceLabel(visual, coordinate),
  );
  assert.equal(new Set(labels).size, labels.length);
});

test("canvas scale labels preserve tiny prices and moves beyond floating-point precision", () => {
  for (const values of [
    ["0.000000000000000000123456", "0.000000000000000000123457"],
    ["1.00000000000000000001", "1.00000000000000000002"],
  ]) {
    const visual = chartVisual(
      values.map((value, at) => ({ at: at * 1000, value, source: "curve" })),
      1000,
    )!;
    const labels = visual.points.map((point) =>
      tradingViewPriceLabel(visual, 300 - point.y),
    );
    assert.notEqual(labels[0], labels[1]);
    assert.notEqual(labels[0], "0");
    assert.ok(
      !labels.includes(tradingViewPriceLabel(visual, 150)),
      "intermediate ticks retain finer precision than either bound",
    );
    assert.equal(visual.points[0]!.value, values[0]);
  }
});

test("missing buckets remain whitespace with bounded long-range memory and source segments", () => {
  const visual = chartVisual(
    [
      { at: 0, value: "1", source: "curve" },
      { at: 1000, value: "2", source: "curve" },
      { at: 3000, value: "3", source: "curve" },
      { at: 3000, value: "4", source: "venue" },
    ],
    1000,
  )!;
  assert.equal(visual.segments.length, 3);
  assert.equal(
    visual.points.length,
    4,
    "same-time pool observations remain exact and inspectable",
  );
  assert.deepEqual(tradingViewTimeline(visual, 1000), [
    { time: 0 },
    { time: 1 },
    { time: 2 },
    { time: 3 },
  ]);
  const long = chartVisual(
    [
      { at: 0, value: "1", source: "curve" },
      { at: 365 * 86400_000, value: "2", source: "curve" },
    ],
    1000,
  )!;
  assert.ok(tradingViewTimeline(long, 1000).length <= 4002);
});

test("activity between buckets follows actual canvas spacing and off-range events disappear", () => {
  const times = [1000, 2000, 6000];
  const coordinate = (at: number) =>
    new Map([
      [1000, -0.1],
      [2000, 0.3],
      [6000, 0.9],
    ]).get(at) ?? null;
  assert.equal(projectChartTime(times, 1000, coordinate), -0.1);
  assert.equal(projectChartTime(times, 1500, coordinate), 0.1);
  assert.ok(Math.abs(projectChartTime(times, 4000, coordinate)! - 0.6) < 1e-10);
  assert.equal(projectChartTime(times, 0, coordinate), null);
  assert.equal(projectChartTime(times, 7000, coordinate), null);
  assert.equal(projectChartTime([1000], 1000, coordinate), -0.1);
});
