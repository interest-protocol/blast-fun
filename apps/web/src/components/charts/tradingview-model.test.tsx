import { combinedVolumes } from "./candle-data";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { exactChartCandle, exactChartPrice, migrationCaptionOffset, nearestPriceSeries } from "./chart-inspection-model";
import { exactChartScale } from "./exact-chart-scale";
import {
  atLiveEdge,
  chartData,
  chartTimestamp,
  distinctTicks,
  elapsedTimeScale,
  keyboardChartRange,
  liveChartRange,
  pannedPosition,
  pointerX,
  queuedChartRange,
  rebaseCoinChartRange,
  resizedLiveChartRange,
  trackpadGestures,
  visibleMove,
  wheelAction,
  wheelPixels,
  withAlpha,
  zoomChartRangeAtPixel,
} from "./tradingview-model";
import { scheduleLines } from "../vesting/schedule-series";

test("a new coin bar keeps the live zoom and anchors a reader browsing history", () => {
  const before = [10, 20, 30, 40, 50, 60];
  const after = [20, 30, 35, 40, 50, 60, 70];
  const live = { from: 3.5, to: 5.75 };
  const history = { from: 1.25, to: 3.5 };
  const width = 120;
  assert.equal(atLiveEdge(live, before.length, width), true);
  assert.equal(atLiveEdge(history, before.length, width), false);
  assert.equal(atLiveEdge({ from: 4.5, to: 6.75 }, before.length, width), false);
  assert.deepEqual(rebaseCoinChartRange(live, before, after, width), { from: 4.5, to: 6.75 });
  assert.deepEqual(rebaseCoinChartRange(history, before, after, width), { from: 0.25, to: 2.5 });
  assert.deepEqual(rebaseCoinChartRange({ from: -1, to: 3 }, before, [20, 30, 40, 50, 60, 70], width), { from: -2, to: 2 });
});

test("resizing keeps the live gutter and leaves a history range alone", () => {
  const live = liveChartRange({ from: 2, to: 5 }, 6, 160);
  const wider = resizedLiveChartRange(live, 6, 160, 320)!;
  assert.equal(atLiveEdge(live, 6, 320), false);
  assert.equal(atLiveEdge(wider, 6, 320), true);
  assert.equal(wider.to - wider.from, live.to - live.from);
  assert.equal(resizedLiveChartRange({ from: -1, to: 3 }, 6, 160, 320), null);

  const narrowFit = { from: 0, to: 349.808 };
  assert.equal(atLiveEdge(narrowFit, 302, 258), false);
  const settled = resizedLiveChartRange(narrowFit, 302, 0, 258, true)!;
  assert.equal(atLiveEdge(settled, 302, 258), true);
  assert.equal(resizedLiveChartRange({ from: -40, to: 290 }, 302, 0, 258, true), null);

  const pinned = liveChartRange({ from: -24, to: 1357 }, 1201, 282);
  assert.equal(pinned.from, 0, "a view wider than the bars starts at the pinned first bar");
  assert.equal(atLiveEdge(pinned, 1201, 282), true);
  const slid = resizedLiveChartRange({ from: 185, to: 1566.28 }, 1201, 0, 282, true)!;
  assert.deepEqual([slid.from, atLiveEdge(slid, 1201, 282)], [0, true], "a fit the pinned edge slid right returns to every bar");
  // Two trades in one slot leave the window: the pinned view loses a bar and must keep exactly one gutter.
  const times = Array.from({ length: 1201 }, (_, index) => index * 250 + (index === 1 ? 100 : 0));
  let shrunk = pinned;
  for (let lost = 1; lost <= 6; lost++) shrunk = rebaseCoinChartRange(shrunk, times.slice(lost - 1), times.slice(lost), 282);
  assert.equal(shrunk.from, 0, "a shrinking timeline stays pinned at its first bar");
  assert.ok(Math.abs((shrunk.to - 1194) / ((shrunk.to - shrunk.from + 1) / 282) - 32) < 1e-6, "the gutter stays exactly 32 px");
  assert.equal(atLiveEdge(shrunk, 1195, 282), true);
});

test("a refreshed fallback time grid keeps both historical time bounds", () => {
  const before = [0, 10, 20];
  const after = [0, 5, 10, 15, 20, 25];
  assert.deepEqual(rebaseCoinChartRange({ from: 0, to: 1 }, before, after, 160), { from: 0, to: 2 });
  assert.deepEqual(rebaseCoinChartRange({ from: -0.5, to: 0.75 }, before, after, 160), { from: -1, to: 1.5 });
});

test("an incoming bar keeps a Back to live or keyboard zoom request made before the chart draws", () => {
  const before = [10, 20, 30, 40, 50, 60];
  const after = [...before, 70];
  const width = 160;
  const history = { from: -1, to: 3 };
  let drawn = history;
  let queued = drawn;
  const viewport = queuedChartRange(() => drawn, (range) => { queued = range; });

  viewport.write(liveChartRange(viewport.read()!, before.length, width));
  assert.deepEqual(drawn, history);
  viewport.write(rebaseCoinChartRange(viewport.read()!, before, after, width));
  assert.deepEqual(queued, { from: 3, to: 7 });
  const pointerZoom = zoomChartRangeAtPixel(viewport.read()!, 79, width, Math.log(0.5) / 0.002);
  assert.deepEqual(pointerZoom, { from: 3.75, to: 5.75 });
  drawn = queued;
  viewport.settle();

  const left = keyboardChartRange("ArrowLeft", viewport.read()!, after.length, width)!;
  assert.ok(left.to < drawn.to);
  assert.deepEqual(keyboardChartRange("ArrowRight", left, after.length, width), drawn);
  assert.equal(keyboardChartRange("Tab", left, after.length, width), null);
  const zoom = keyboardChartRange("+", drawn, after.length, width)!;
  assert.ok(zoom.to - zoom.from < drawn.to - drawn.from);
  assert.ok(atLiveEdge(zoom, after.length, width));
  assert.ok(keyboardChartRange("-", zoom, after.length, width)!.from < zoom.from);
  viewport.write(zoom);
  viewport.write(rebaseCoinChartRange(viewport.read()!, after, [...after, 80], width));
  assert.deepEqual(queued, { from: zoom.from + 1, to: zoom.to + 1 });
});

test("canvas scales retain tiny prices and distinguish large, tightly spaced prices", () => {
  for (const values of [
    ["0.00000000000000000001", "0.00000000000000000002"],
    ["100000000000000000000.0001", "100000000000000000000.0002"],
    ["0", "123.45"],
  ]) {
    const scale = exactChartScale(values);
    assert.equal(scale.coordinate(values[0]!), 0);
    assert.equal(scale.coordinate(values[1]!), 100);
    assert.ok(scale.format(0).length <= 12);
    assert.ok(scale.format(100).length <= 12);
  }
  const flat = exactChartScale(["0", "0"]);
  assert.ok(Number.isFinite(flat.coordinate("0")));
  assert.equal(flat.format(flat.coordinate("0")), "0");
});

test("compact coin ticks round to the chosen precision and carry across a digit", () => {
  const tiny = exactChartScale(["0.000067345", "0.000067389"]);
  assert.equal(tiny.format(0, 3, true), "0.0₄673");
  assert.equal(tiny.format(100, 3, true), "0.0₄674");
  const carry = exactChartScale(["0.009994", "0.009998"]);
  assert.equal(carry.format(100, 3, true), "0.01");
});

test("inspection reports a held close only inside a flat line on the same source", () => {
  const curve = { times: [10, 30], values: new Map([[10, "1.000000000005"], [30, "1.000000000005"]]) };
  const venue = { times: [30, 50], values: new Map([[30, "5"], [50, "6"]]) };
  assert.equal(exactChartPrice([curve, venue], 20, -1, true), "1.000000000005");
  assert.equal(exactChartPrice([curve, venue], 20, -1, false), undefined);
  assert.equal(exactChartPrice([curve, venue], 40, -1, true), undefined);
  assert.equal(exactChartPrice([curve, venue], 30, -1, false), undefined);
  assert.equal(exactChartPrice([curve, venue], 30, 0, false), "1.000000000005");
  assert.equal(exactChartPrice([curve, venue], 30, 1, false), "5");
  // A Live step holds the previous trade's price until the next one, and stops at a break or the trace's end.
  const live = { times: [10, 20, 25, 30], values: new Map([[10, "1"], [20, "2"], [25, "2"]]) };
  assert.equal(exactChartPrice([live], 15, 0, "step"), "1");
  assert.equal(exactChartPrice([live], 27, 0, "step"), "2");
  assert.equal(exactChartPrice([live], 30, 0, "step"), undefined);
  assert.equal(exactChartPrice([live], 35, 0, "step"), undefined);
  assert.equal(exactChartPrice([live], 5, 0, "step"), undefined);
});

test("inspection takes OHLC and volume from the selected pool even when their closes match", () => {
  const curve = { open: "1", high: "3", low: "1", close: "2", volume: "0.003" };
  const venue = { open: "2", high: "4", low: "0.9", close: "2", volume: "93.1" };
  const series = [curve, venue].map((candle) => ({
    values: new Map([[10, candle.close]]), times: [10], candles: new Map([[10, candle]]),
  }));
  assert.equal(exactChartCandle(series, 10, 0), curve);
  assert.equal(exactChartCandle(series, 10, 1), venue);
  assert.equal(exactChartCandle(series, 10, -1), undefined);
  assert.equal(exactChartCandle(series.slice(1), 10, -1), venue);
  assert.equal(exactChartCandle(series, 11, 0), undefined);
});

test("a graduation caption stays within a narrow plot as its line pans", () => {
  for (const x of [2, 50, 80, 120, 168]) {
    const left = x + migrationCaptionOffset(x, 170, 124);
    assert.ok(left >= 4 && left + 124 <= 166);
  }
});

test("a tap on a candle wick takes priority over another pool with a closer close", () => {
  const curve = { close: 10, top: 10, bottom: 50 };
  const venue = { close: 53, top: 52, bottom: 55 };
  assert.equal(nearestPriceSeries([curve, venue], 50), 0);
  assert.equal(nearestPriceSeries([curve, venue], 53), 1);
  assert.equal(nearestPriceSeries([curve, curve], 50), -1);
});

test("timestamp sorting keeps the last observation without inventing missing samples", () => {
  assert.deepEqual(
    chartData([
      { time: chartTimestamp(3000), value: 3 },
      { time: chartTimestamp(1000), value: 1 },
      { time: chartTimestamp(1000), value: 2 },
    ]),
    [
      { time: chartTimestamp(1000), value: 2 },
      { time: chartTimestamp(3000), value: 3 },
    ],
  );
});

test("continuous cliffs split at the exact release, while steps retain the value after each release", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.3 },
    { x: 1, y: 1 },
  ];
  assert.deepEqual(scheduleLines(points, false), [
    points.slice(0, 2),
    points.slice(2),
  ]);
  assert.deepEqual(scheduleLines(points, true), [
    [points[0], points[2], points[3]],
  ]);
  assert.deepEqual(
    scheduleLines(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      false,
    ),
    [
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    ],
  );
});

test("every production chart shares one library loader and creation point", () => {
  const root = new URL("../", import.meta.url);
  const files: string[] = [];
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (/\.tsx?$/.test(next) && !/\.test\./.test(next)) files.push(next);
    }
  }
  visit(root.pathname);
  const engines = files.filter((path) =>
    /createChart\(/.test(readFileSync(path, "utf8")),
  );
  assert.equal(engines.length, 1);
  assert.ok(engines[0]!.endsWith("/charts/TradingViewChart.tsx"));
  for (const path of files)
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /(?:from|import\()\s*["'](?:recharts|liveline)["']/,
    );
});

test("irregular time spacing is proportional, with drawing error bounded below a pixel", () => {
  for (const input of [
    [0, 400, 1000],
    [0, 60_000, 86_400_000],
    [0, 1, 86_400_000],
  ]) {
    const scale = elapsedTimeScale(input);
    assert.ok(scale.timeline.length <= 4097);
    for (const at of input) {
      const actual = (scale.snap(at) - input[0]!) / (input.at(-1)! - input[0]!);
      const expected = (at - input[0]!) / (input.at(-1)! - input[0]!);
      assert.ok(Math.abs(actual - expected) * 1414 < 0.2);
      assert.ok(scale.timeline.includes(scale.snap(at)));
    }
  }
});

test("same-bucket pool volumes are summed exactly once without combining their OHLC", () => {
  assert.deepEqual(
    combinedVolumes([
      {
        at: 60_000,
        volume: "100000000000000000000.000000000000000001",
        down: true,
      },
      { at: 60_000, volume: "0.000000000000000002", down: false },
      { at: 180_000, volume: "7", down: true },
    ]),
    [
      {
        at: 60_000,
        volume: "100000000000000000000.000000000000000003",
        combined: true,
        color: "var(--muted)",
      },
      { at: 180_000, volume: "7", combined: false, color: "var(--down)" },
    ],
  );
});


test("historical TSUI tick and last-value labels leave room for the plot", () => {
  const values = ["0.000199795432711782189195387208639779", "0.00022123456789123456789123456789"];
  const scale = exactChartScale(values);
  for (const coordinate of [-10, 0, 25, 50, 75, 100, 110]) {
    const label = scale.format(coordinate);
    assert.ok(label.length <= 12, `axis label is too long: ${label}`);
    assert.ok(Number(label) > 0);
  }
  assert.notEqual(scale.format(0), scale.format(100));
});


test("adaptive axis precision distinguishes narrow moves within the compact label budget", () => {
  for (const values of [["1.000001", "1.000002"], ["1.000000001", "1.000000002"], ["0.0001997954", "0.0001997955"], ["1234.0001", "1234.0002"]]) {
    const scale = exactChartScale(values);
    assert.notEqual(scale.format(0), scale.format(100));
    assert.ok(scale.format(0).length <= 12);
    assert.ok(scale.format(100).length <= 12);
  }
});

test("a price line takes the move across the visible range, over every segment together", () => {
  const rising = [{ time: 1, value: 1 }, { time: 2, value: 3 }, { time: 3, value: 2 }, { time: 4, value: 0.5 }];
  const all = { from: -Infinity, to: Infinity };
  assert.equal(visibleMove([rising], all), "down");
  assert.equal(visibleMove([rising], { from: 1, to: 3 }), "up");
  assert.equal(visibleMove([rising], { from: 2, to: 4 }), "down");
  assert.equal(visibleMove([rising], { from: 1.5, to: 2.5 }), null, "one value in view has no move");
  assert.equal(visibleMove([[{ time: 1, value: 2 }], [{ time: 1.5 }, { time: 5, value: 2 }]], all), "up", "flat is up, whitespace skipped");
  assert.equal(visibleMove([[{ time: 1, value: 5 }], [{ time: 9, value: 4 }]], all), "down");
  assert.equal(visibleMove([], all), null);
});

test("an area fades from its line colour", () => {
  assert.equal(withAlpha("#0f7f48", 0.2), "rgba(15, 127, 72, 0.2)");
  assert.equal(withAlpha("#fff", 0), "rgba(255, 255, 255, 0)");
  assert.equal(withAlpha("rgb(63, 211, 139)", 0.2), "rgba(63, 211, 139, 0.2)");
  assert.equal(withAlpha("oklch(0.7 0.1 150)", 0.2), "rgba(0, 0, 0, 0)");
});

test("zoomed-in axis ticks gain digits until no two labels read the same (audit F40)", () => {
  const format = (value: number, significant = 3) => value.toPrecision(significant);
  assert.deepEqual(distinctTicks([1.2341, 1.2342, 1.2343], format), ["1.23410", "1.23420", "1.23430"]);
  assert.deepEqual(distinctTicks([1, 2], format), ["1.00", "2.00"]);
  // A formatter that cannot say more keeps its own labels.
  assert.deepEqual(distinctTicks([1.01, 1.02], () => "1"), ["1", "1"]);
});

test("a plain vertical wheel scrolls the page, a sideways swipe pans the chart, Ctrl/⌘ zooms (audit F41)", () => {
  const wheel = (deltaX: number, deltaY: number, keys: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) =>
    wheelAction({ ctrlKey: false, metaKey: false, deltaX, deltaY, ...keys });
  assert.equal(wheel(0, 120), "page");
  assert.equal(wheel(4, 120), "page");
  assert.equal(wheel(-60, 8), "pan");
  assert.equal(wheel(60, 0), "pan");
  assert.equal(wheel(60, 0, { ctrlKey: true }), "zoom");
  assert.equal(wheel(0, -120, { metaKey: true }), "zoom");
  // Swiping right by two bar widths shows two later bars; lines and pages scale to pixels.
  assert.equal(pannedPosition(3, 20, 10), 5);
  assert.equal(pannedPosition(3, -20, 10), 1);
  assert.equal(wheelPixels(3, 1), 48);
  assert.equal(wheelPixels(1, 2), 800);
  assert.equal(wheelPixels(7, 0), 7);
});

test("Safari gesture events zoom only for a desktop trackpad, and a missing pointer falls back to the centre (audit F41)", () => {
  assert.equal(trackpadGestures({ GestureEvent: class {} }, { maxTouchPoints: 0 }), true, "Mac Safari trackpad pinch");
  assert.equal(trackpadGestures({ GestureEvent: class {} }, { maxTouchPoints: 5 }), false, "iOS: the library already zooms a touch pinch");
  assert.equal(trackpadGestures({}, { maxTouchPoints: 0 }), false);
  assert.equal(pointerX(150, 100), 50);
  assert.equal(pointerX(undefined as unknown as number, 100), null);
  assert.equal(pointerX(Number.NaN, 100), null);
});
