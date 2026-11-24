import assert from "node:assert/strict";
import test from "node:test";

import { VESTING_MAX_MS, cliffMonths, vestedAtoms, vestingMsSql, vestingSteps, vestingStepsSql, type VestingTimes } from "./vesting.ts";

/**
 * T-020 alignment: the vesting arithmetic over blast-infra's real
 * `chain_read_v1.vesting_schedules` (T-036, OA-18), whose `cliff_ms` and
 * `end_ms` are NUMERIC and whose cliff holds everything back until it ends.
 */

const DAY = 86_400_000;
const START = 1_790_000_000_000;
const TOTAL = 1_000_000n;

/** A schedule with a three-month cliff over a twelve-month unlock (30-day months). */
const CLIFFED: VestingTimes = { start_ms: START, cliff_end_ms: START + 90 * DAY, end_ms: START + 360 * DAY };
const LINEAR: VestingTimes = { start_ms: START, cliff_end_ms: START, end_ms: START + 360 * DAY };

test("a cliff holds everything back, then releases what vested since the start", () => {
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START), 0n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 90 * DAY - 1), 0n);
  // The cliff ends a quarter of the way in, so a quarter unlocks at once.
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 90 * DAY), 250_000n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 180 * DAY), 500_000n);
});

test("without a cliff the unlock is linear from the start, rounded down", () => {
  assert.equal(vestedAtoms(TOTAL, LINEAR, START), 0n);
  assert.equal(vestedAtoms(TOTAL, LINEAR, START + 1 * DAY), 2_777n);
  assert.equal(vestedAtoms(7n, LINEAR, START + 180 * DAY), 3n);
});

test("from the end everything is vested, and a schedule that ends at its start is vested at once", () => {
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 360 * DAY), TOTAL);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 3_600 * DAY), TOTAL);
  assert.equal(vestedAtoms(TOTAL, { start_ms: START, cliff_end_ms: START, end_ms: START }, START), TOTAL);
  // A schedule clamped at VESTING_MAX_MS still vests nothing before its cliff.
  const clamped: VestingTimes = { start_ms: START, cliff_end_ms: VESTING_MAX_MS, end_ms: VESTING_MAX_MS };
  assert.equal(vestedAtoms(TOTAL, clamped, START + 360 * DAY), 0n);
});

/** The same schedule as the contract runs it: 12 monthly steps, the first three held by the cliff. */
const MONTHLY = { period_ms: String(30 * DAY), periods: "12" };

test("with steps, nothing more unlocks between two steps, as the contract counts", () => {
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 90 * DAY - 1, MONTHLY), 0n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 90 * DAY, MONTHLY), 250_000n);
  // A day after a step the straight line would show more; the contract has nothing to pay.
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 91 * DAY, MONTHLY), 250_000n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 120 * DAY - 1, MONTHLY), 250_000n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 120 * DAY, MONTHLY), 333_333n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 360 * DAY - 1, MONTHLY), 916_666n);
  assert.equal(vestedAtoms(TOTAL, CLIFFED, START + 360 * DAY, MONTHLY), TOTAL);
  // One step pays everything at once at its end.
  const single = { period_ms: String(360 * DAY), periods: "1" };
  assert.equal(vestedAtoms(TOTAL, LINEAR, START + 359 * DAY, single), 0n);
  assert.equal(vestedAtoms(TOTAL, LINEAR, START + 360 * DAY, single), TOTAL);
  // Steps too long for a Date (end clamped) still count from the start.
  const huge = { period_ms: String(30 * DAY), periods: "100000000" };
  const far: VestingTimes = { start_ms: START, cliff_end_ms: START, end_ms: VESTING_MAX_MS };
  assert.equal(vestedAtoms(100_000_000n, far, START + 60 * DAY, huge), 2n);
});

test("vestingSteps reads a row without steps as unknown", () => {
  assert.equal(vestingSteps({ period_ms: null, periods: null }), null);
  assert.deepEqual(vestingSteps({ period_ms: "5", periods: "2" }), { period_ms: "5", periods: "2" });
  assert.equal(vestingStepsSql("v"), "to_jsonb(v)->>'period_ms' AS period_ms, to_jsonb(v)->>'periods' AS periods");
});

test("the cliff is reported in whole 30-day months, 0 without one", () => {
  assert.equal(cliffMonths(LINEAR), 0);
  assert.equal(cliffMonths(CLIFFED), 3);
  assert.equal(cliffMonths({ start_ms: START, cliff_end_ms: START + 44 * DAY }), 1);
  assert.equal(cliffMonths({ start_ms: START, cliff_end_ms: START - DAY }), 0);
});

test("the SQL clamp keeps a NUMERIC time inside what a Date holds", () => {
  assert.equal(vestingMsSql("start_ms + cliff_ms"), `LEAST(start_ms + cliff_ms, ${VESTING_MAX_MS}::numeric)::text`);
  assert.equal(new Date(VESTING_MAX_MS).toISOString(), "+275760-09-13T00:00:00.000Z");
});

test("vesting duration labels preserve month schedules and sub-month precision", async () => {
  const { vestingDurationText, vestingDurationMs } = await import("./vesting.ts");
  assert.equal(vestingDurationText(Number(vestingDurationMs(6, "months"))), "6 mo");
  assert.equal(vestingDurationText(Number(vestingDurationMs(2, "weeks"))), "2 wk");
  assert.equal(vestingDurationText(Number(vestingDurationMs(3, "days"))), "3 d");
  assert.equal(vestingDurationText(Number(vestingDurationMs(5, "minutes"))), "5 min");
  assert.equal(vestingDurationText(30_000), "30 s");
  assert.equal(vestingDurationText(3_600_000), "1 h");
  assert.equal(vestingDurationText(250), "250 ms");
  assert.equal(vestingDurationText(0), "0 s");
});
