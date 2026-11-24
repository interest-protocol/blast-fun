import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAfterResponseScheduler,
  createRequestWork,
  reserveAfterResponse,
  runWithRequestWork,
  trackRequestWork,
} from "./request-work.ts";
import { deferred } from "../../../core/test/kit.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("actual provider work and dynamically registered children retain request ownership", async () => {
  const scheduler = createAfterResponseScheduler();
  const request = createRequestWork(scheduler);
  const first = deferred(),
    child = deferred();
  let complete = false;
  runWithRequestWork(request, () =>
    trackRequestWork(
      first.promise.then(() => {
        trackRequestWork(child.promise);
      }),
    ),
  );
  const finishing = request.complete().then(() => {
    complete = true;
  });
  first.resolve();
  await turn();
  assert.equal(complete, false);
  child.resolve();
  await finishing;
  assert.throws(
    () =>
      runWithRequestWork(request, () => trackRequestWork(Promise.resolve())),
    /closed/,
  );
  assert.throws(() => trackRequestWork(Promise.resolve()), /active ownership/);
});

test("two reservations refuse before work and attached jobs start after actual completion", async () => {
  const scheduler = createAfterResponseScheduler();
  const request = createRequestWork(scheduler);
  const slow = deferred();
  let started = 0;
  const first = runWithRequestWork(request, reserveAfterResponse)!;
  const second = runWithRequestWork(request, reserveAfterResponse)!;
  assert.equal(runWithRequestWork(request, reserveAfterResponse), null);
  first.attach(async () => {
    started++;
    await slow.promise;
  });
  second.release();
  second.release();
  assert.throws(() => second.attach(async () => {}), /not available/);
  assert.equal(started, 0);
  await request.complete();
  assert.equal(started, 1);
  assert.equal(scheduler.active, 1);
  await request.complete();
  assert.equal(started, 1);
  slow.resolve();
  await scheduler.drain();
  assert.equal(scheduler.active, 0);
});

test("shutdown refuses new work, starts accepted jobs and drains a fresh job context", async () => {
  const scheduler = createAfterResponseScheduler();
  const request = createRequestWork(scheduler);
  const provider = deferred(),
    nested = deferred();
  let started = false,
    drained = false;
  const reservation = runWithRequestWork(request, reserveAfterResponse)!;
  reservation.attach(async () => {
    started = true;
    trackRequestWork(
      provider.promise.then(() => {
        trackRequestWork(nested.promise);
      }),
    );
    assert.throws(reserveAfterResponse, /active request/);
  });
  scheduler.stop();
  assert.equal(scheduler.reserve(), null);
  const finishing = scheduler.drain().then(() => {
    drained = true;
  });
  await request.complete();
  assert.equal(started, true);
  await turn();
  assert.equal(drained, false);
  assert.equal(scheduler.active, 1);
  provider.resolve();
  await turn();
  assert.equal(drained, false);
  nested.resolve();
  await finishing;
  assert.equal(scheduler.active, 0);
});

test("sync task failure and unused reservations release exactly once without leaking data", async () => {
  let failures = 0;
  const scheduler = createAfterResponseScheduler(() => {
    failures++;
  });
  const request = createRequestWork(scheduler);
  const reservation = runWithRequestWork(request, reserveAfterResponse)!;
  reservation.attach(() => {
    throw new Error("private provider data");
  });
  assert.throws(() => reservation.attach(async () => {}), /not available/);
  assert.throws(reservation.release, /cannot be discarded/);
  runWithRequestWork(request, reserveAfterResponse);
  await request.complete();
  await scheduler.drain();
  assert.equal(failures, 1);
  assert.equal(scheduler.active, 0);
});

test("a failed job retains its slot until its already-started provider settles", async () => {
  const scheduler = createAfterResponseScheduler();
  const request = createRequestWork(scheduler);
  const provider = deferred();
  runWithRequestWork(request, reserveAfterResponse)!.attach(async () => {
    trackRequestWork(provider.promise);
    throw new Error("synthetic failure");
  });
  await request.complete();
  await turn();
  assert.equal(scheduler.active, 1);
  provider.resolve();
  await scheduler.drain();
  assert.equal(scheduler.active, 0);
});
