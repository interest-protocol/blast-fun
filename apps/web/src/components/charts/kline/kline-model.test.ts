import assert from "node:assert/strict";
import test from "node:test";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { barChanges, foldTrade, klineBars, pricePrecision, readChartSettings, rollUp, rollUpSource, toggleIndicator, DEFAULT_CHART_SETTINGS, type Bar } from "./kline-model.ts";

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

test("5m–4h roll up from 1m and 1w from 1d", () => {
  assert.deepEqual(rollUp([bar(T0, 1, 2, 1, 2, 1), bar(T0 + MINUTE, 2, 5, 0.5, 4, 2), bar(T0 + 5 * MINUTE, 4, 4, 4, 4, 1)], "5m"),
    [bar(T0, 1, 5, 0.5, 4, 3), bar(T0 + 5 * MINUTE, 4, 4, 4, 4, 1)]);
  assert.deepEqual(["1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w"].map((interval) => rollUpSource(interval as never)), [null, null, "1m", "1m", "1m", "1m", null, "1d"]);
});

test("settings survive a reload and ignore anything unknown", () => {
  assert.deepEqual(readChartSettings(null), DEFAULT_CHART_SETTINGS);
  assert.deepEqual(readChartSettings("{"), DEFAULT_CHART_SETTINGS);
  assert.deepEqual(readChartSettings(JSON.stringify({ indicators: ["RSI", "nope", "MA"] })), { indicators: ["MA", "RSI"] });
  const on = toggleIndicator(DEFAULT_CHART_SETTINGS, "BOLL");
  assert.deepEqual(on.indicators, ["MA", "BOLL", "VOL"]);
  assert.deepEqual(toggleIndicator(on, "MA").indicators, ["BOLL", "VOL"]);
});
