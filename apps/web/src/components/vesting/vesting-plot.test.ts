import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailChart } from "./DetailChart";
import { vestingChartData, vestingPlot } from "./vesting-plot";
import { vestingScheduleLabel } from "./schedule-display";
import type {
  PublicVesting,
  VestingTerms,
} from "@blast/core/modules/vesting/model.ts";

const continuous: VestingTerms = {
  kind: "linear",
  start_ms: "1000",
  cliff_ms: "0",
  period_ms: "1",
  periods: "1000",
};

test("continuous vesting plots one straight slope, regardless of duration or token precision", () => {
  assert.deepEqual(vestingPlot({ terms: continuous, total: "100" }), [
    { time: 1000n, amount: 0n },
    { time: 2000n, amount: 100n },
  ]);
  assert.equal(vestingScheduleLabel(continuous), "Linear vesting");
  const huge = { ...continuous, periods: "10000000000000000" };
  assert.equal(
    vestingPlot({ terms: huge, total: "18446744073709551615" })?.length,
    2,
  );
});

test("a continuous cliff stays flat, jumps to accrued tokens, then resumes the original slope", () => {
  assert.deepEqual(
    vestingPlot({ terms: { ...continuous, cliff_ms: "250" }, total: "100" }),
    [
      { time: 1000n, amount: 0n },
      { time: 1250n, amount: 0n },
      { time: 1250n, amount: 25n },
      { time: 2000n, amount: 100n },
    ],
  );
  const last = vestingPlot({
    terms: { ...continuous, cliff_ms: "1000" },
    total: "100",
  })!;
  assert.deepEqual(last.slice(0, 3), [
    { time: 1000n, amount: 0n },
    { time: 2000n, amount: 0n },
    { time: 2000n, amount: 100n },
  ]);
});

test("checkpoint graphs retain exact horizontal and vertical corners, with no diagonal unlocks", () => {
  const terms: VestingTerms = {
    kind: "checkpoints",
    checkpoints: [
      { timestamp_ms: "1000", cumulative_amount: "20" },
      { timestamp_ms: "1500", cumulative_amount: "70" },
      { timestamp_ms: "2000", cumulative_amount: "100" },
    ],
  };
  const points = vestingPlot({ terms, total: "100" })!;
  assert.equal(vestingScheduleLabel(terms), "Checkpoint vesting");
  points.forEach((point, i) => {
    const previous = points[i - 1];
    if (previous)
      assert.ok(
        point.time === previous.time || point.amount === previous.amount,
      );
  });
  assert.deepEqual(points.at(-1), { time: 2000n, amount: 100n });
});

test("historical linear-module stepped schedules keep their original steps and label", () => {
  const terms = { ...continuous, period_ms: "250", periods: "4" };
  assert.equal(vestingScheduleLabel(terms), "Stepped vesting");
  const points = vestingPlot({ terms, total: "100" })!;
  assert.ok(
    points.some((point) => point.time === 1250n && point.amount === 25n),
  );
  points.forEach((point, i) => {
    const previous = points[i - 1];
    if (previous)
      assert.ok(
        point.time === previous.time || point.amount === previous.amount,
      );
  });
  assert.ok(
    vestingPlot({ terms: { ...terms, periods: "1000000000" }, total: "100" })!
      .length < 1030,
  );
});

test("a deleted checkpoint schedule with unknown terms does not invent a plot", () => {
  assert.equal(
    vestingPlot({
      terms: { kind: "checkpoints", checkpoints: null, checkpoint_count: "3" },
      total: "100",
    }),
    null,
  );
});

const schedule: PublicVesting = {
  schedule_id: "0x1",
  coin_type: "0x2::sui::SUI",
  beneficiary: "0x2",
  creator: null,
  total: "100",
  released: "0",
  refunded: "0",
  refund_recipient: null,
  cancel_cap_id: null,
  terms: continuous,
  status: "active",
  created_timestamp_ms: null,
  created_digest: null,
  coin_name: null,
  coin_symbol: "SUI",
  coin_decimals: 9,
  coin_icon_url: null,
  indexed: true,
};

test("server chart reserves its accessible slot without CSP-blocked library markup", () => {
  const html = renderToStaticMarkup(
    createElement(DetailChart, { schedule, now: 1500n }),
  );
  assert.match(html, /role="img"/);
  assert.match(html, /00:00:01/);
  assert.doesNotMatch(html, /aria-expanded/);
  assert.doesNotMatch(html, /<canvas|recharts-|style=/);
});

test("stepped chart shows three upcoming releases before the full release disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(DetailChart, {
      schedule: {
        ...schedule,
        terms: { ...continuous, period_ms: "250", periods: "4" },
      },
      now: 1100n,
    }),
  );
  const preview = html.slice(
    html.indexOf('aria-label="Upcoming releases"'),
    html.indexOf('</dl>'),
  );
  assert.equal((preview.match(/<time /g) ?? []).length, 3);
  assert.match(preview, /Next release/);
  assert.match(html, /aria-expanded="false"[^>]*><span[^>]*>View all releases/);
});

test("chart normalizes u64 balances before converting to numbers and ends the solid line at now", () => {
  const chart = vestingChartData(
    { ...schedule, total: "18446744073709551615" },
    1500n,
  )!;
  assert.deepEqual(chart.projection, [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]);
  assert.deepEqual(chart.current, { x: 0.5, y: 0.499999 });
  assert.deepEqual(chart.unlocked.at(-1), chart.current);
  assert.equal(chart.next, null);
});

test("stepped chart ends between releases at the accrued amount and marks the next step", () => {
  const chart = vestingChartData(
    { ...schedule, terms: { ...continuous, period_ms: "250", periods: "4" } },
    1400n,
  )!;
  assert.deepEqual(chart.current, { x: 0.4, y: 0.25 });
  assert.deepEqual(chart.next, { x: 0.5, y: 0.5 });
  assert.deepEqual(chart.unlocked.at(-1), chart.current);
  for (let i = 1; i < chart.unlocked.length; i++) {
    const previous = chart.unlocked[i - 1]!,
      point = chart.unlocked[i]!;
    assert.ok(previous.x === point.x || previous.y === point.y);
  }
});

test("chart clamps now to the range, with no future marker after completion", () => {
  assert.deepEqual(vestingChartData(schedule, 0n)!.current, { x: 0, y: 0 });
  const chart = vestingChartData(schedule, 9999n)!;
  assert.deepEqual(chart.current, { x: 1, y: 1 });
  assert.equal(chart.next, null);
});

test("canceled chart shows only its original projection; unavailable terms show no chart", () => {
  const chart = vestingChartData({ ...schedule, status: "canceled" }, 1500n)!;
  assert.equal(chart.projection.length, 2);
  assert.deepEqual(chart.unlocked, []);
  assert.equal(chart.current, null);
  assert.equal(chart.next, null);
  assert.equal(
    vestingChartData(
      {
        ...schedule,
        terms: {
          kind: "checkpoints",
          checkpoints: null,
          checkpoint_count: "3",
        },
      },
      1500n,
    ),
    null,
  );
});
