import assert from "node:assert/strict";
import test from "node:test";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { barChanges, fillGaps, foldTrade, foldTrades, MAX_FILLED_BARS, klineBars, pricePrecision, readChartSettings, toggleIndicator, tradedBars, forcesLine, DEFAULT_CHART_SETTINGS, priceParts, volumeText, rsiValues, fibLabelRows, chartDate, ticksInside, plotHeightFor, topGap, PANE_INDICATORS, type Bar, type IndicatorName } from "./kline-model.ts";

const MINUTE = 60_000;
const T0 = 1_795_188_300_000; // a 5-minute boundary

function series(source: "curve" | "venue", candles: ReadonlyArray<[number, string, string, string, string, bigint]>): DrawnSeries {
  return {
    source,
    page: {
      poolKey: `${source}:0x1`, source, venue: source === "curve" ? "blast" : "cetus", interval: "1m", migration: null,
      candles: candles.map(([bucketStart, open, high, low, close, volumeQuote]) => ({ bucketStart, open, high, low, close, volumeQuote, trades: 1 })),
    },
  };
}

const bar = (timestamp: number, open: number, high: number, low: number, close: number, volume = 1): Bar => ({ timestamp, open, high, low, close, volume });

test("a coin's bars are priced per whole token, in USD when the quote rate is known, and the migration bucket is one bar", () => {
  // SUI at 3.12 USDC is 0.00312 quote atoms per SUI atom (9 vs 6 decimals).
  const sui = klineBars([series("venue", [[T0, "0.003", "0.0033", "0.0029", "0.00312", 5_000_000n]])], 9, 6, "1");
  assert.deepEqual(sui, [bar(T0, 3, 3.3, 2.9, 3.12, 5)]);
  const joined = klineBars([
    series("curve", [[T0, "1", "2", "1", "2", 1_000_000_000n]]),
    series("venue", [[T0, "2", "4", "0.5", "3", 2_000_000_000n], [T0 + MINUTE, "3", "3", "3", "3", 0n]]),
  ], 9, 9, null);
  assert.deepEqual(joined, [bar(T0, 1, 4, 0.5, 3, 3), bar(T0 + MINUTE, 3, 3, 3, 3, 0)]);
});

test("Live shows a quiet coin's last close from before the window as a flat bar at its start", () => {
  const quiet = { ...series("curve", []), carriedClose: { timestampMs: T0, price: "2" } };
  assert.deepEqual(klineBars([quiet], 9, 9, null), [bar(T0, 2, 2, 2, 2, 0)]);
  const traded = { ...series("curve", [[T0 + 5_000, "2", "3", "2", "3", 1_000_000_000n]]), carriedClose: { timestampMs: T0, price: "2" } };
  assert.deepEqual(klineBars([traded], 9, 9, null), [bar(T0, 2, 2, 2, 2, 0), bar(T0 + 5_000, 2, 3, 2, 3, 1)]);
});

test("precision keeps four significant digits of the smallest price, from dollars to 1e-12", () => {
  assert.equal(pricePrecision([]), 2);
  assert.equal(pricePrecision([bar(0, 3, 3, 3.12, 3)]), 3);
  assert.equal(pricePrecision([bar(0, 1, 1, 0.001234, 1)]), 6);
  assert.equal(pricePrecision([bar(0, 1, 1, 1.5e-12, 1)]), 15);
  assert.equal(pricePrecision([bar(0, 1, 1, 1e-20, 1)]), 16);
});

test("a newer tail updates in place; changed history resets", () => {
  const shown = [bar(T0, 1, 1, 1, 1), bar(T0 + MINUTE, 1, 2, 1, 2)];
  assert.deepEqual(barChanges(shown, shown), { kind: "update", bars: [], kept: shown });
  const grown = [shown[0]!, bar(T0 + MINUTE, 1, 3, 1, 3), bar(T0 + 2 * MINUTE, 3, 3, 3, 3)];
  assert.deepEqual(barChanges(shown, grown), { kind: "update", bars: grown.slice(1), kept: grown });
  // A rolling window drops its oldest bar: the screen keeps it and only the tail moves.
  const rolled = grown.slice(1);
  assert.deepEqual(barChanges(grown, rolled), { kind: "update", bars: [], kept: grown });
  assert.deepEqual(barChanges(shown, [bar(T0, 9, 9, 9, 9), shown[1]!]), { kind: "reset" });
  assert.deepEqual(barChanges(shown, shown.slice(0, 1)), { kind: "reset" });
  assert.deepEqual(barChanges(shown, [bar(T0 - MINUTE, 1, 1, 1, 1), ...shown]), { kind: "reset" }, "older history arrived");
  assert.deepEqual(barChanges([], shown), { kind: "reset" });
});

test("a trade extends its open bar or opens the next one at the previous close", () => {
  const bars = [bar(T0, 1, 2, 1, 2, 10)];
  assert.deepEqual(foldTrade(bars, "1m", T0 + 30_000, 2.5, 4), bar(T0, 1, 2.5, 1, 2.5, 14));
  assert.deepEqual(foldTrade(bars, "1m", T0 + MINUTE + 1, 1.5, 3), bar(T0 + MINUTE, 2, 2, 1.5, 1.5, 3));
  assert.deepEqual(foldTrade(bars, "1s", T0 + 1_500, 3, 1), bar(T0 + 1_000, 2, 3, 2, 3, 1));
  assert.equal(foldTrade(bars, "1m", T0 - 1, 9, 1), null, "history already holds it");
  assert.equal(foldTrade(bars, "1m", T0 + 1, 0, 1), null);
});

test("every trade history has not caught up with stays on the open bars, in time order", () => {
  const history = [bar(T0, 1, 2, 1, 2, 10)];
  const trades = [{ timestampMs: T0 + 2_500, price: 1.5, volume: 2 }, { timestampMs: T0 + 1_200, price: 3, volume: 1 }];
  assert.deepEqual(foldTrades(history, "1s", trades), [history[0]!, bar(T0 + 1_000, 2, 3, 2, 3, 1), bar(T0 + 2_000, 3, 3, 1.5, 1.5, 2)]);
  assert.deepEqual(foldTrades(history, "1m", trades), [bar(T0, 1, 3, 1, 1.5, 13)]);
  assert.equal(foldTrades(history, "1m", []), history);
});

test("settings survive a reload and ignore anything unknown", () => {
  assert.deepEqual(readChartSettings(null), DEFAULT_CHART_SETTINGS);
  assert.deepEqual(readChartSettings("{"), DEFAULT_CHART_SETTINGS);
  assert.deepEqual(readChartSettings(JSON.stringify({ indicators: ["RSI", "nope", "MA"] })), { indicators: ["MA", "RSI"] });
  const on = toggleIndicator(DEFAULT_CHART_SETTINGS, "BOLL");
  assert.deepEqual(on.indicators, ["MA", "BOLL", "VOL"]);
  assert.deepEqual(toggleIndicator(on, "MA").indicators, ["BOLL", "VOL"]);
});

test("a quiet coin's series is continuous: flat bars at the previous close through the current bucket, the newest buckets only", () => {
  const M = 60_000;
  const bar = (minute: number, close: number, volume = 1, open = close): Bar => ({ timestamp: minute * M, open, high: Math.max(open, close), low: Math.min(open, close), close, volume });
  assert.deepEqual(fillGaps([bar(0, 2), bar(3, 5)], "1m", 5 * M + 30_000),
    [bar(0, 2), bar(1, 2, 0), bar(2, 2, 0), bar(3, 5, 1, 2), bar(4, 5, 0), bar(5, 5, 0)], "each bar opens at the previous close and the tail runs to now");
  assert.deepEqual(fillGaps([], "1m", 0), []);
  assert.deepEqual(fillGaps([{ ...bar(0, 2), timestamp: 20_000 }, bar(1, 3)], "1m", M), [bar(0, 2), bar(1, 3, 1, 2)], "a carried close snaps to its bucket");
  const sparse = fillGaps([bar(0, 1), bar(9, 2)], "1m", 9 * M, 4);
  assert.deepEqual(sparse.map((row) => row.timestamp / M), [0, 6, 7, 8, 9], "only the newest buckets up to the cap are filled");
  assert.equal(fillGaps([bar(0, 1), bar(MAX_FILLED_BARS * 3, 2)], "1m", MAX_FILLED_BARS * 3 * M).length, MAX_FILLED_BARS + 1);
  assert.equal(tradedBars(fillGaps([bar(0, 2), bar(3, 5)], "1m", 3 * M)), 2);
  const traded = (count: number) => Array.from({ length: count }, (_, i) => bar(i, 1));
  assert.equal(forcesLine(traded(9)), true, "nine traded buckets draw a line");
  assert.equal(forcesLine([...traded(10), bar(10, 1, 0)]), false, "ten traded buckets draw candles; flat bars do not count");
});

test("an older quiet bucket the server fills later reloads the chart so the plot shows it", () => {
  const bar = (minute: number, close: number, volume = 1): Bar => ({ timestamp: minute * 60_000, open: close, high: close, low: close, close, volume });
  const shown = [bar(0, 2), bar(1, 2, 0), bar(2, 2)];
  assert.equal(barChanges(shown, [bar(0, 2), bar(1, 3), bar(2, 2)]).kind, "reset");
  assert.equal(barChanges(shown, [bar(0, 4), bar(1, 2, 0), bar(2, 2)]).kind, "reset", "a traded bar that changed still reloads");
});

test("the readout counts four or more leading zeros and gives volume short", () => {
  assert.deepEqual(priceParts(0.0000812, 7), { text: "0.0000812", zeros: 4, rest: "812" });
  assert.deepEqual(priceParts(0.000812, 6), { text: "0.000812" });
  assert.deepEqual(priceParts(1.5, 2), { text: "1.50" });
  assert.equal(volumeText(0), "0");
  assert.equal(volumeText(-0), "0");
  assert.equal(volumeText(0.004567), "0.00456");
  assert.equal(volumeText(0.0000004567), "0.0₆456");
  assert.equal(volumeText(12.345), "12.35");
  assert.equal(volumeText(15_400), "15.4K");
});

test("RSI has no reading while the price stands still, and 100 when it only rises", () => {
  const flat = rsiValues(Array.from({ length: 20 }, () => 0.0000812));
  assert.ok(flat.every((value) => value === null));
  const rising = rsiValues(Array.from({ length: 20 }, (_, index) => 1 + index));
  assert.equal(rising[13], null);
  assert.equal(rising[14], 100);
  const mixed = rsiValues(Array.from({ length: 30 }, (_, index) => 10 + (index % 2 ? 1 : -1)));
  assert.ok(mixed.slice(14).every((value) => value !== null && value > 40 && value < 60));
});

test("Fibonacci labels closer than 14 px to a kept one are left out", () => {
  assert.deepEqual(fibLabelRows([0, 5, 30, 35, 50]), [true, false, true, false, true]);
  assert.deepEqual(fibLabelRows([100, 80, 60, 40]), [true, true, true, true]);
});

test("axis dates read as short local dates, and a label that would run off the plot is dropped", () => {
  const at = Date.UTC(2026, 10, 26, 14, 30);
  assert.equal(chartDate(at, "HH:mm", "UTC"), "14:30");
  assert.match(chartDate(at, "MM-DD", "UTC"), /Nov 26/);
  assert.match(chartDate(at, "YYYY-MM-DD HH:mm", "UTC"), /Thu.*Nov 26.*14:30/);
  const ticks = [{ coord: 5, text: "01:00" }, { coord: 100, text: "05:00" }, { coord: 196, text: "Nov 26" }];
  assert.deepEqual(ticksInside(ticks, 200).map((tick) => tick.text), ["05:00"]);
});

test("the top gap leaves the asked px free over the highest value, as KLineCharts widens the range", () => {
  // KLineCharts (YAxisImp.calcRange): the gaps are shares of the value range, added to both ends.
  const freePx = (top: number, bottom: number, height: number) => height * top / (1 + top + bottom);
  for (const [px, height, bottom] of [[76, 290, .06], [72, 200, .06], [22, 101, .05]] as const)
    assert.ok(Math.abs(freePx(topGap(px, height, bottom), bottom, height) - px) < 1e-9, `${px}px of ${height}`);
  assert.ok(freePx(76 / 290, .06, 290) < 60, "the plain px share leaves far less room");
});

test("the plot grows by one pane per study, whatever the mix, and its default matches the loading block", () => {
  // The CSS fallback (--kline-plot-height: 26rem = 416px desktop at the default text size, 306px phone) assumes the default MA + VOL.
  assert.equal(plotHeightFor(["MA", "VOL"], false), 416);
  assert.equal(plotHeightFor(["MA", "VOL"], true), 306);
  for (const phone of [false, true]) {
    const base = plotHeightFor([], phone);
    for (let mask = 0; mask < 8; mask++) {
      const panes = PANE_INDICATORS.filter((_, i) => mask & (1 << i));
      const all: IndicatorName[] = ["MA", "EMA", "BOLL", ...panes];
      assert.equal(plotHeightFor(all, phone), base + panes.length * (phone ? 81 : 101), `${phone ? "phone" : "desktop"} ${panes.join("+") || "no panes"}`);
    }
  }
});
