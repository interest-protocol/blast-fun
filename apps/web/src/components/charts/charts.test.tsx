import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";

import { RaiseChart } from "#web/components/presale-pages/RaiseChart.tsx";
import { FIXTURE_NOW, fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { RAISE_CHART_HEIGHT, raiseData, raiseGeometry, raiseScale } from "#web/components/presale-pages/raise-geometry.ts";
import { trendData, trendDomain } from "#web/components/social/profile/portfolio-trend.ts";
import { LibraryProviders } from "#web/components/ui-libraries/LibraryProviders.tsx";

import { Sparkline } from "./Sparkline";
import { gatePixel, gateSparkCoordinates, sparkCoordinates, sparkData, sparkDomain, sparkUp, sparkXDomain, type SparkPoint } from "./spark-model";

/**
 * Legacy reference geometry and current CSP-clean SSR slots.
 * TradingView rendering and proportional time adapters have separate unit/browser coverage.
 */

const NONCE = "chartsTestNonce0123456789abcdef";
const html = (node: ReactNode) => renderToString(<LibraryProviders nonce={NONCE}>{node}</LibraryProviders>);
const styleAttributes = (markup: string) => [...markup.matchAll(/\sstyle="([^"]*)"/g)].map((match) => match[1]!);

/** The gate's `series()` (seeded, ending at `end` times its start), so the values are the gate's own. */
function gateSeries(seed: number, end: number, n = 28): number[] {
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

const byIndex = (values: readonly number[]): SparkPoint[] => values.map((value, index) => [index, value]);

test("OA-28 M4 sparkline: legacy reference coordinates match the gate's spark() at every size it draws", () => {
  const cases: readonly (readonly [number[], number, number])[] = [
    [gateSeries(0.05 * 100, 4.2), 89, 28], // a call card (Kestrel, 4.2×)
    [gateSeries(0.002 * 1e5, 0.65), 89, 28], // a call under water
    [gateSeries(0.0005 * 1e5, 4.2, 40), 160, 40], // Since launch
    [gateSeries(7, 1.1, 60), 120, 28], // a Blast-mode card's 60 ticks
    [gateSeries(9, 0.9, 60), 320, 40], // the panel
  ];
  for (const [values, width, height] of cases) {
    const ours = sparkCoordinates(byIndex(values), width, height);
    const gate = gateSparkCoordinates(values, width, height);
    for (let i = 0; i < values.length; i += 1) {
      assert.ok(Math.abs(ours[i]![0] - gate[i]![0]) < 1e-9 && Math.abs(ours[i]![1] - gate[i]![1]) < 1e-9, `${width}×${height} point ${i}`);
    }
    // The extremes sit 3 px inside the box; the area closes on its bottom edge (the domain's floor maps to `height`).
    const ys = ours.map((point) => point[1]);
    assert.ok(Math.abs(Math.min(...ys) - 3) < 1e-9 && Math.abs(Math.max(...ys) - (height - 3)) < 1e-9);
  }
  // A flat line sits on the lower inset, as the gate's `(max − min) || 1` puts it.
  for (const [, y] of sparkCoordinates([[0, 5], [1, 5]], 89, 28)) assert.ok(Math.abs(y - 25) < 1e-9, String(y));
  assert.deepEqual(sparkDomain([[0, 5], [1, 5]], 28), [5 - 3 / 22, 6 + 3 / 22]);
  // Green when it ends at or above its start.
  assert.equal(sparkUp([[0, 1], [1, 1]]), true);
  assert.equal(sparkUp([[0, 1], [1, 0.99]]), false);
  // A real series is spaced by time: a gap stays one straight segment between two real prices.
  assert.deepEqual(sparkCoordinates([[0, 1], [10, 2], [40, 1.5]], 40, 28).map((point) => point[0]), [0, 10, 40]);
});

test("OA-28 M4: legacy reference data puts every vertex on the tenth of a pixel the gate's path writes", () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // A sparkline: through the chart's own scales (x over its first to last, y over sparkDomain across the box).
  for (const [values, width, height] of [[gateSeries(5, 4.2), 89, 28], [gateSeries(9, 0.9, 60), 320, 40]] as const) {
    const points = byIndex(values);
    const [x0, x1] = sparkXDomain(points);
    const [y0, y1] = sparkDomain(points, height);
    const drawn = sparkData(points, width, height).map((point) => [((point.x - x0) / (x1 - x0)) * width, height - ((point.v - y0) / (y1 - y0)) * height]);
    const gate = gateSparkCoordinates(values, width, height).map(([x, y]) => [gatePixel(x), gatePixel(y)]);
    drawn.forEach(([x, y], i) => assert.ok(near(x!, gate[i]![0]!) && near(y!, gate[i]![1]!), `${width}×${height} vertex ${i}`));
  }
  // The raise chart at 640: `M0 Y(0)` exact, every other vertex rounded.
  const geometry = raiseGeometry(fixtureDetail("mrdn"), FIXTURE_NOW);
  const scale = raiseScale(geometry, 640);
  raiseData(geometry, 640).forEach((point, i) => {
    const original = geometry.line[i]!;
    const [x, y] = [scale.x(point.t), scale.y(point.v)];
    const [gx, gy] = i === 0 ? [scale.x(original.t), scale.y(original.v)] : [gatePixel(scale.x(original.t)), gatePixel(scale.y(original.v))];
    assert.ok(Math.abs(x - gx) < 1e-6 && Math.abs(y - gy) < 1e-9, `raise vertex ${i}: ${x},${y} vs ${gx},${gy}`);
  });
  // The gold card's line in its 400×100 box, before stretching.
  const trend = gateSeries(21.9, 1.32, 40).map((usd, index) => ({ at_ms: index, usd }));
  const { min, max } = trendDomain(trend);
  trendData(trend).forEach((point, i) => {
    assert.ok(near(point.x * 400, gatePixel((i / 39) * 400)), `trend x ${i}`);
    assert.ok(near(100 - ((point.v - min) / (max - min)) * 100, gatePixel(100 - ((trend[i]!.usd - min) / (max - min)) * 100)), `trend y ${i}`);
  });
});

test("OA-28 M4 raise chart: the gate's X and Y, the line from zero at the open to the total at the edge", () => {
  const mrdn = fixtureDetail("mrdn");
  const geometry = raiseGeometry(mrdn, FIXTURE_NOW);
  const scale = raiseScale(geometry, 682);
  assert.equal(scale.y(0), RAISE_CHART_HEIGHT - 26);
  assert.equal(scale.y(geometry.maxV), 24);
  assert.equal(scale.x(geometry.t0), 0);
  assert.equal(scale.x(geometry.t1), 682);
  assert.equal(geometry.maxV, Math.max(geometry.target * 1.12, geometry.total * 1.06, 1));
  assert.deepEqual(geometry.line[0], { t: geometry.t0, v: 0 });
  assert.deepEqual(geometry.line.at(-1), { t: geometry.t1, v: geometry.total });
  assert.equal(geometry.line.length, mrdn.raise.points.length + 2);
  assert.ok(geometry.open && geometry.now, "an open sale draws its now dot on its last point");
  assert.equal(raiseGeometry(fixtureDetail("cblt"), FIXTURE_NOW).now, null, "a funded sale has none");
});

test("OA-28 M4: every chart's server HTML is its empty place, with no inline style (ui-libraries.md §3.6)", () => {
  const points = byIndex(gateSeries(5, 4.2));
  for (const markup of [
    html(<Sparkline className="spark" height={28} points={points} slot="call-sparkline" width={89} />),
    html(<Sparkline className="spark" height={28} points={null} slot="call-sparkline" width={89} />),
  ]) {
    assert.equal(markup, '<span aria-hidden="true" class="spark" data-slot="call-sparkline"></span>');
  }
  const raise = html(<RaiseChart detail={fixtureDetail("mrdn")} marks={[]} nowMs={FIXTURE_NOW} overlays={{ mine: true, following: true, big: true, thesis: false }} />);
  assert.match(raise, /^<div class="[^"]*chartBox[^"]*" id="chartBox"><\/div>$/);
  assert.deepEqual(styleAttributes(raise), []);
});

test("resized funding charts keep their baseline, target and observed endpoint inside the plot", () => {
  const geometry = raiseGeometry(fixtureDetail("mrdn"), FIXTURE_NOW);
  for (const height of [120, 280, 600, 900]) {
    const scale = raiseScale(geometry, 640, height);
    assert.equal(scale.y(0), height - 26);
    assert.ok(Math.abs(scale.y(geometry.maxV) - 24) < 1e-9);
    assert.equal(scale.x(geometry.t1), 640);
    for (const point of raiseData(geometry, 640, height)) {
      assert.ok(Number.isFinite(point.t) && Number.isFinite(point.v));
      assert.ok(scale.y(point.v) >= 24 && scale.y(point.v) <= height - 26);
    }
    const endpoint = raiseData(geometry, 640, height).at(-1)!;
    assert.ok(Math.abs(scale.y(endpoint.v) - scale.y(geometry.total)) <= 0.05);
  }
});
