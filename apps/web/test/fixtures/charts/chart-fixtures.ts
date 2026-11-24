/**
 * The gate's own chart inputs, for the development fixture
 * `/dev/social/charts`, the browser check (`scripts/charts-check.ts`) and the
 * tests. **Never shipped**: only those import this file. Each case names the
 * gate's call that draws it (`blast-feel-preview-oa32.html`), so the pixel
 * comparison renders the same values on both sides.
 */

import type { SparkPoint } from "#web/components/charts/spark-model.ts";

/** The gate's `series()`: a seeded walk from 1 that ends at `end` (a multiple), `n` points. */
export function gateSeries(seed: number, end: number, n = 28): number[] {
  let x = Math.sin(seed * 9.31) * 1e4;
  const r = () => (x = Math.sin(x) * 1e4) - Math.floor(x);
  const out: number[] = [];
  let v = 1;
  for (let i = 0; i < n; i += 1) {
    v += (r() - 0.48) * 0.09 + (end - 1) / n;
    out.push(Math.max(0.05, v));
  }
  const k = end / out[n - 1]!;
  return out.map((p, i) => 1 + (p * k - 1) * (i / (n - 1)) ** 0.8);
}

const byIndex = (values: readonly number[]): SparkPoint[] => values.map((value, index) => [index, value] as const);

export type SparkCase = Readonly<{
  key: string;
  /** What the case is in the product. */
  label: string;
  points: readonly SparkPoint[];
  width: number;
  height: number;
  up: boolean;
  /** Drawn as wide as its slot (the panel), the slot this wide. */
  fill?: number;
  /** The gate's own call, for the comparison page. */
  gate: string;
}>;

/** The gate's `rng`. */
function gateRng(seed: number): () => number {
  let x = Math.sin(seed) * 1e4;
  return () => (x = Math.sin(x * 9.7 + seed) * 1e4) - Math.floor(x);
}

/**
 * A trading coin's 60 price ticks back from the price now, as the gate seeds
 * them from the coin's mark (deterministic, no ticker); the index is the
 * gate's x.
 */
function gateTicks(mark: string, now: number): SparkPoint[] {
  const r = gateRng(mark.charCodeAt(0) * 7 + mark.charCodeAt(2) * 3);
  const history: number[] = [];
  let value = now;
  for (let index = 0; index < 60; index += 1) {
    history.unshift(value);
    value = value / Math.exp((r() - 0.5) * 0.014);
  }
  return byIndex(history);
}

/** Kestrel at $0.0021 and Lumen at $0.0013, the gate's two trading sales. */
const TICKS: Readonly<Record<string, SparkPoint[]>> = { KSTL: gateTicks("kstl", 0.0021), LUMN: gateTicks("lumn", 0.0013) };

const lane = (symbol: "KSTL" | "LUMN") => TICKS[symbol]!;
const ends = (points: readonly SparkPoint[]) => points[points.length - 1]![1] >= points[0]![1];

/** Kestrel at 4.2× and Lumen at 0.65× (the presale prices $0.0005 and $0.002), as the gate's surfaces seed them. */
export const SPARK_CASES: readonly SparkCase[] = [
  { key: "call", label: "Post call card (89×28)", points: byIndex(gateSeries(0.05, 4.2)), width: 89, height: 28, up: true, gate: "spark(series(0.05, 4.2), true)" },
  { key: "call-down", label: "Profile call row, under water (89×28)", points: byIndex(gateSeries(200, 0.65)), width: 89, height: 28, up: false, gate: "spark(series(200, 0.65), false)" },
  { key: "since", label: "Sale page, Since launch (160×40)", points: byIndex(gateSeries(50, 4.2, 40)), width: 160, height: 40, up: true, gate: "spark(series(50, 4.2, 40), true, 160, 40)" },
  { key: "lane", label: "Blast-mode card, Kestrel's 60 ticks (120×28)", points: lane("KSTL"), width: 120, height: 28, up: ends(lane("KSTL")), gate: "spark(BX.hist.kstl, BX.hist.kstl[59] >= BX.hist.kstl[0], 120, 28)" },
  { key: "panel", label: "Blast-mode panel, Lumen's 60 ticks (320×40 in 352)", points: lane("LUMN"), width: 320, height: 40, up: ends(lane("LUMN")), fill: 352, gate: "spark(BX.hist.lumn, BX.hist.lumn[59] >= BX.hist.lumn[0], 320, 40)" },
];

/** The gold card's 30-day line as the gate draws Kai's (`goldTrend('kai')`): 40 points of `series(21.9, 1.32, 40)`. */
export const TREND_CASE = Object.freeze({
  key: "trend",
  values: gateSeries("kai".length * 7.3, 1.32, 40),
  width: 300,
  height: 54,
  gate: "goldTrend('kai')",
});

/**
 * The raise chart: Meridian on the presale pages' sample payload, 640 wide,
 * without markers — the gate's Blast-mode panel chart, `bxChart(PRESALES.mrdn, 640)`.
 */
export const RAISE_CASE = Object.freeze({ key: "raise", sale: "mrdn", width: 640, gate: "bxChart(PRESALES.mrdn, 640)" });
