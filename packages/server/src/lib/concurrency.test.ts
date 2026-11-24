import assert from "node:assert/strict";
import test from "node:test";

import {
  concurrencyFromEnvironment,
  createSemaphore,
  retryAfterMs,
  SemaphoreTimeoutError,
} from "@blast/server/lib/concurrency.ts";

test("semaphore admits up to its limit, queues in order and sheds waiters after the timeout", async () => {
  const semaphore = createSemaphore(2);
  const first = await semaphore.acquire(0);
  const second = await semaphore.acquire(0);
  assert.equal(semaphore.active, 2);
  await assert.rejects(semaphore.acquire(0), SemaphoreTimeoutError);
  await assert.rejects(semaphore.acquire(10), SemaphoreTimeoutError);
  assert.equal(semaphore.waiting, 0);

  const order: string[] = [];
  const third = semaphore.acquire(1_000).then((release) => { order.push("third"); return release; });
  const fourth = semaphore.acquire(1_000).then((release) => { order.push("fourth"); return release; });
  assert.equal(semaphore.waiting, 2);
  first();
  first();
  const thirdRelease = await third;
  assert.deepEqual(order, ["third"]);
  assert.equal(semaphore.active, 2);
  second();
  const fourthRelease = await fourth;
  assert.deepEqual(order, ["third", "fourth"]);
  thirdRelease();
  fourthRelease();
  assert.equal(semaphore.active, 0);
  assert.throws(() => createSemaphore(0), TypeError);
});

test("concurrency settings are bounded integers", () => {
  assert.equal(concurrencyFromEnvironment({}, "LIMIT", 16, 256), 16);
  assert.equal(concurrencyFromEnvironment({ LIMIT: " 8 " }, "LIMIT", 16, 256), 8);
  for (const bad of ["0", "-1", "1.5", "257", "many"]) {
    assert.throws(
      () => concurrencyFromEnvironment({ LIMIT: bad }, "LIMIT", 16, 256),
      /^Error: LIMIT must be an integer from 1 to 256\.$/,
    );
  }
});

test("Retry-After accepts delta seconds and HTTP dates; x-rate-limit-reset is epoch seconds", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after": "120" }), now), 120_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Fri, 25 Sep 2026 12:00:30 GMT" }), now), 30_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Fri, 25 Sep 2026 11:59:00 GMT" }), now), 0);
  assert.equal(retryAfterMs(new Headers({ "x-rate-limit-reset": String(now / 1_000 + 90) }), now), 90_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "5", "x-rate-limit-reset": String(now / 1_000 + 90) }), now), 5_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" }), now), undefined);
  assert.equal(retryAfterMs(new Headers(), now), undefined);
});
