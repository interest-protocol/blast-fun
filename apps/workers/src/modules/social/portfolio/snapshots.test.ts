import assert from "node:assert/strict";
import test from "node:test";
import { utcDay, utcDayStart } from "./snapshots.ts";

test("OA-25 Q16: the UTC day boundary is 00:00:00.000 UTC, whatever the server's zone", () => {
  assert.equal(utcDay(Date.UTC(2026, 9, 5, 23, 59, 59, 999)), "2026-10-05");
  assert.equal(utcDay(Date.UTC(2026, 9, 6, 0, 0, 0, 0)), "2026-10-06");
  assert.equal(utcDay(Date.UTC(2024, 1, 29, 12)), "2024-02-29");
  assert.equal(utcDay(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), "2026-12-31");
  assert.equal(utcDayStart("2026-10-06"), Date.UTC(2026, 9, 6));
});
