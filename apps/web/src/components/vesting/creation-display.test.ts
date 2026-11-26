import assert from "node:assert/strict";
import { test } from "node:test";
import { compactVestingAmount, vestingDate } from "./creation-display";
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
test("schedule dates are read and shown in UTC", () => {
  const instant = releaseTimestamp("2026-12-04T12:00", "start");
  assert.equal(instant, 1_796_385_600_000n);
  assert.equal(releaseTimestamp("2026-12-04T12:00:00.000Z", "start"), instant);
  assert.equal(vestingDate(instant), "4 Dec 2026, 12:00");
  for (const text of ["2026-02-30T12:00", "2026-13-01T12:00", "2026-12-04T24:00", "2026-12-04T12:00+01:00"])
    assert.throws(() => releaseTimestamp(text, "start"), CreationFieldError);
});
test("instants past the JavaScript date range show raw milliseconds instead of throwing", () => {
  assert.equal(
    vestingDate(8_640_000_000_000_001n),
    "Unix 8640000000000001 ms",
  );
});
