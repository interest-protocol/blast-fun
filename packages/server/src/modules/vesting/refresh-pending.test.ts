import assert from "node:assert/strict";
import test from "node:test";
import { refreshPendingVestings } from "./refresh-pending.ts";

test("refresh visits all 25 attempts with at most two active, even after failures", async () => {
  let active = 0;
  let peak = 0;
  const visited: number[] = [];
  await refreshPendingVestings(Array.from({ length: 25 }, (_, i) => i), async (i) => {
    active++;
    peak = Math.max(peak, active);
    visited.push(i);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (i % 3 === 0) throw new Error("provider unavailable");
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(visited, Array.from({ length: 25 }, (_, i) => i));
  await refreshPendingVestings([], async () => { assert.fail("empty selection"); });
});

test("cancellation stops new refreshes and still waits for active operations", async () => {
  const controller = new AbortController();
  const visited: number[] = [];
  let release!: () => void;
  let finished = false;
  const active = new Promise<void>((resolve) => { release = resolve; });
  const work = refreshPendingVestings([1, 2, 3, 4], async (attempt) => {
    visited.push(attempt);
    await active;
  }, controller.signal).then(() => { finished = true; });
  controller.abort();
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await work;
  assert.deepEqual(visited, [1, 2]);
  assert.equal(finished, true);
  await refreshPendingVestings([5], async () => { assert.fail("already aborted"); }, controller.signal);
});
