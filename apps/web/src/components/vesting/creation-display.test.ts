import assert from "node:assert/strict";
import { test } from "node:test";
import { compactVestingAmount, localVestingDate } from "./creation-display";
import { releaseTimestamp, CreationFieldError } from "./creation-model";

test("large financial displays preserve exact atoms and never round into the next unit", () => {
  const amount = 124968397112711982n;
  assert.equal(compactVestingAmount(amount, 9), "≈ 124.9683M");
  assert.equal(compactVestingAmount(999999999999n, 9), "999.999999999");
  assert.equal(amount, 124968397112711982n);
  assert.equal(compactVestingAmount(1_000_000_000_000_000n, 9), "≈ 1M");
  assert.equal(compactVestingAmount(1_050_000n, 0), "≈ 1.05M");
  assert.equal(compactVestingAmount(2_500_000_000n, 0), "≈ 2.5B");
  assert.equal(compactVestingAmount(1_000n, 0), "≈ 1K");
});
test("Lisbon daylight-saving gaps and overlaps require explicit valid instants", () => {
  assert.throws(
    () => releaseTimestamp("2027-03-28T01:30", "start", "Europe/Lisbon"),
    CreationFieldError,
  );
  assert.throws(
    () => releaseTimestamp("2026-10-25T01:30", "start", "Europe/Lisbon"),
    CreationFieldError,
  );
  const first = releaseTimestamp(
    "2026-10-25T01:30+01:00[Europe/Lisbon]",
    "start",
  );
  const second = releaseTimestamp(
    "2026-10-25T01:30+00:00[Europe/Lisbon]",
    "start",
  );
  assert.equal(second - first, 3600000n);
  assert.equal(localVestingDate(first, "Europe/Lisbon"), "25 Oct 2026, 01:30");
  assert.equal(localVestingDate(second, "Europe/Lisbon"), "25 Oct 2026, 01:30");
  assert.throws(
    () => releaseTimestamp("2026-02-30T12:00", "start", "Europe/Lisbon"),
    CreationFieldError,
  );
});
test("instants past the JavaScript date range show raw milliseconds instead of throwing", () => {
  assert.equal(
    localVestingDate(8_640_000_000_000_001n, "Europe/Lisbon"),
    "Unix 8640000000000001 ms",
  );
});
