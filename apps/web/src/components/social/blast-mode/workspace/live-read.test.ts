import assert from "node:assert/strict";
import test from "node:test";
import { startWorkspaceLiveRead, WorkspaceDataUnavailable } from "./live-read";
import { handClock } from "../../../../../test/fixtures/workspace/live-clock";

const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };

test("an eligible live read repeats without overlap and hiding aborts disposable work and ignores its late answer", async () => {
  const time = handClock();
  const requests: { signal: AbortSignal; answer: (value: string) => void }[] = [];
  const shown: unknown[] = [];
  const stop = startWorkspaceLiveRead({
    clock: time.clock,
    intervalMs: 15_000,
    read: (signal) => new Promise<string>((answer) => requests.push({ signal, answer })),
    receive: (result) => shown.push(result),
  });
  await flush();
  assert.equal(requests.length, 1);
  time.advance(60_000);
  assert.equal(requests.length, 1, "a slow request has no overlapping poll");
  requests[0]!.answer("first");
  await flush();
  assert.deepEqual(shown, [{ status: "ready", value: "first" }]);
  assert.equal(time.timers.size, 1);
  time.advance(15_000);
  await flush();
  assert.equal(requests.length, 2);
  stop();
  assert.equal(requests[1]!.signal.aborted, true);
  requests[1]!.answer("hidden late answer");
  await flush();
  time.advance(600_000);
  assert.equal(requests.length, 2);
  assert.equal(shown.length, 1);
  assert.equal(time.timers.size, 0);
});


test("a known coverage gap ends pending and stops polling; transient failures can recover", async () => {
  for (const unavailable of [true, false]) {
    const time = handClock();
    const shown: unknown[] = [];
    let calls = 0;
    const stop = startWorkspaceLiveRead({
      clock: time.clock,
      intervalMs: 1_000,
      read: async () => {
        if (++calls === 1) throw unavailable ? new WorkspaceDataUnavailable("No coverage") : new Error("Offline");
        return "recovered";
      },
      receive: result => shown.push(result),
    });
    await flush();
    assert.deepEqual(shown, [{ status: "error", value: null, ...(unavailable ? { unavailable: true } : {}) }]);
    time.advance(1_000);
    await flush();
    assert.equal(calls, unavailable ? 1 : 2);
    if (!unavailable) assert.deepEqual(shown[1], { status: "ready", value: "recovered" });
    stop();
    assert.equal(time.timers.size, 0);
  }
});
