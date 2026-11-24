import assert from "node:assert/strict";
import test from "node:test";
import { forEachConcurrent } from "./concurrent.mjs";

test("load-test imports stay bounded and process every batch exactly once", async () => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  const batches = Array.from({ length: 100 }, (_, index) => index);
  await forEachConcurrent(batches, 8, async (batch) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(batch);
    active--;
  });
  assert.equal(maximum, 8);
  assert.equal(active, 0);
  assert.deepEqual(seen.sort((a, b) => a - b), batches);
});

test("a failed import stops scheduling and drains in-flight work before rejecting", async () => {
  const failure = new Error("import failed");
  let drained = false;
  const seen = [];
  await assert.rejects(forEachConcurrent([0, 1, 2, 3], 2, async (batch) => {
    seen.push(batch);
    if (batch === 0) throw failure;
    await new Promise((resolve) => setImmediate(resolve));
    drained = true;
  }), (error) => error === failure);
  assert.deepEqual(seen, [0, 1]);
  assert.equal(drained, true);
});

test("empty imports need no workers and invalid concurrency is rejected", async () => {
  await forEachConcurrent([], 8, () => assert.fail("unexpected worker"));
  await assert.rejects(forEachConcurrent([], 0, () => {}), TypeError);
});
