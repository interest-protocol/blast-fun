import assert from "node:assert/strict";
import test from "node:test";

import { tapeEvent } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
import { arrivals, dripGapMs } from "./happening-model";

test("UI-05 arrivals: only events newer than the shown ones and not shown yet, oldest first; drip spreads them over the poll", () => {
  const a = tapeEvent({ activity_id: "1:0:0:0", occurred_at_ms: 10 });
  const b = tapeEvent({ activity_id: "2:0:0:0", occurred_at_ms: 20 });
  const c = tapeEvent({ activity_id: "3:0:0:0", occurred_at_ms: 30 });
  const old = tapeEvent({ activity_id: "0:0:0:0", occurred_at_ms: 5 });
  assert.deepEqual(arrivals([a], [c, b, a, old]).map((event) => event.activity_id), ["2:0:0:0", "3:0:0:0"]);
  assert.deepEqual(arrivals([c], [c, b]), []);
  assert.equal(dripGapMs(1, 30_000), 4_000);
  assert.equal(dripGapMs(9, 30_000), 3_000);
  assert.equal(dripGapMs(40, 30_000), 1_200);
});
