import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseInterval, scheduleBounds, vestingDate } from "./schedule-display";

test("release dates keep seconds and milliseconds that are not zero", () => {
  assert.equal(vestingDate("1798806600000"), "2027-01-01 12:30 UTC");
  assert.equal(vestingDate("1798806615000"), "2027-01-01 12:30:15 UTC");
  assert.equal(vestingDate("1798806615250"), "2027-01-01 12:30:15.250 UTC");
  assert.equal(vestingDate("8640000000000001"), "Unix 8640000000000001 ms");
});

test("release intervals use the largest whole unit and fall back to milliseconds", () => {
  assert.equal(releaseInterval("86400000"), "1 day");
  assert.equal(releaseInterval("7200000"), "2 hours");
  assert.equal(releaseInterval("90000"), "90 seconds");
  assert.equal(releaseInterval("1500"), "1500 ms");
});

test("schedule bounds run from the first to the last release", () => {
  assert.deepEqual(
    scheduleBounds({ kind: "linear", start_ms: "1000", cliff_ms: "0", period_ms: "100", periods: "10" }),
    [1000n, 2000n],
  );
  assert.deepEqual(
    scheduleBounds({
      kind: "checkpoints",
      checkpoints: [
        { timestamp_ms: "1000", cumulative_amount: "1" },
        { timestamp_ms: "2000", cumulative_amount: "2" },
        { timestamp_ms: "3000", cumulative_amount: "3" },
      ],
    }),
    [1000n, 3000n],
  );
  assert.equal(scheduleBounds({ kind: "checkpoints", checkpoints: null, checkpoint_count: "3" }), null);
});
