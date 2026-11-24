import assert from "node:assert/strict";
import test from "node:test";
import { pollInterval, spreadMs } from "./polling.ts";

test("a poll is spread over 20% by the last answer's millisecond, the same for every render of one answer", () => {
  assert.equal(spreadMs(30_000, 1_700_000_000_000), 30_000);
  assert.equal(spreadMs(30_000, 1_700_000_000_500), 33_000);
  assert.equal(spreadMs(30_000, 1_700_000_000_999), 35_994);
  const answered = { state: { dataUpdatedAt: 1_700_000_000_250, errorUpdatedAt: 0, dataUpdateCount: 2, errorUpdateCount: 0 } };
  assert.equal(pollInterval(60_000, answered), pollInterval(60_000, answered), "stable across renders, so TanStack keeps its timer");
  assert.equal(pollInterval(60_000, answered), 63_000);
  assert.equal(pollInterval(60_000, { state: { dataUpdatedAt: 1_000, errorUpdatedAt: 2_750, dataUpdateCount: 1, errorUpdateCount: 1 } }), 69_000, "a later failure re-rolls the spread");
});

test("the first repeat after a load lands anywhere in 20-120% of the period, so tabs loaded by one deploy spread over all of it", () => {
  const firstAnswer = (at: number) => ({ state: { dataUpdatedAt: at, errorUpdatedAt: 0, dataUpdateCount: 1, errorUpdateCount: 0 } });
  assert.equal(pollInterval(60_000, firstAnswer(1_700_000_000_000)), 12_000);
  assert.equal(pollInterval(60_000, firstAnswer(1_700_000_000_500)), 42_000);
  assert.equal(pollInterval(60_000, firstAnswer(1_700_000_000_999)), 71_940);
  assert.equal(pollInterval(60_000, { state: { dataUpdatedAt: 0, errorUpdatedAt: 1_700_000_000_500, dataUpdateCount: 0, errorUpdateCount: 1 } }), 66_000, "a failed first read never retries sooner than the period");
});
