import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { pollUntilAborted } from "./poll.ts";

test("shutdown finishes an active worker pass and skips the next one", async () => {
  const shutdown = new AbortController();
  const started = Promise.withResolvers<void>();
  const pass = Promise.withResolvers<number>();
  let passes = 0;
  let finished = false;
  const running = pollUntilAborted(shutdown.signal, () => {
    passes += 1;
    started.resolve();
    return pass.promise;
  }).then(() => { finished = true; });

  await started.promise;
  shutdown.abort();
  await setImmediate();
  assert.equal(finished, false);
  pass.resolve(60_000);
  await running;
  assert.equal(passes, 1);
  assert.equal(getEventListeners(shutdown.signal, "abort").length, 0);
});

test("worker waits release their abort listener after either the timer or shutdown", async () => {
  const shutdown = new AbortController();
  const waiting = Promise.withResolvers<void>();
  try {
    let passes = 0;
    const running = pollUntilAborted(shutdown.signal, async () => {
      passes += 1;
      if (passes === 1) return 1;
      assert.equal(passes, 2);
      assert.equal(getEventListeners(shutdown.signal, "abort").length, 0);
      waiting.resolve();
      return 60_000;
    });

    await Promise.race([running, waiting.promise]);
    await setImmediate();
    assert.equal(getEventListeners(shutdown.signal, "abort").length, 1);
    shutdown.abort();
    await running;
    assert.equal(getEventListeners(shutdown.signal, "abort").length, 0);
  } finally {
    shutdown.abort();
  }
});

test("a failed worker pass keeps its original error during shutdown", async () => {
  const shutdown = new AbortController();
  const failure = new Error("worker pass failed");
  await assert.rejects(pollUntilAborted(shutdown.signal, async () => {
    shutdown.abort();
    throw failure;
  }), (error) => error === failure);
  await pollUntilAborted(shutdown.signal, async () => {
    assert.fail("a stopped worker must skip the first pass");
  });
});
