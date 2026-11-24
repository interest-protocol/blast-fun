import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { partnerCapacity } from "./capacity.ts";
import { PartnerScheduler } from "./scheduler.ts";
import { syntheticCapacity } from "./capacity.test.ts";

test("fair scheduler bounds primary work and isolates tenant queues, cancellation and lifetime lanes", async () => {
  const scheduler = new PartnerScheduler(
    partnerCapacity(JSON.stringify(syntheticCapacity)),
  );
  const signal = new AbortController().signal;
  let active = 0,
    peak = 0;
  const order: string[] = [];
  const work = (id: string) =>
    scheduler.run(id, id + "-key", signal, async () => {
      active++;
      peak = Math.max(peak, active);
      await setTimeout(10);
      order.push(id);
      active--;
      return id;
    });
  const noisy = Array.from({ length: 4 }, () => work("noisy"));
  const overflow = work("noisy");
  await assert.rejects(overflow);
  const quiet = work("quiet");
  await quiet;
  assert.ok(
    order.indexOf("quiet") <= 3,
    "quiet tenant gets a round-robin quantum before noisy backlog drains",
  );
  await Promise.all(noisy);
  assert.equal(peak, 2);
  const lanes = Array.from({ length: 4 }, () => scheduler.lane("noisy"));
  assert.throws(() => scheduler.lane("noisy"));
  const quietRelease = scheduler.lane("quiet");
  for (const release of lanes) {
    release();
    release();
  }
  quietRelease();
  const controller = new AbortController();
  const running = [work("noisy"), work("noisy")];
  const cancelled = scheduler.run(
    "quiet",
    "cancelled-key",
    controller.signal,
    async () => {
      assert.fail("cancelled queue must not execute");
    },
  );
  controller.abort();
  await assert.rejects(cancelled);
  await Promise.all(running);
  await setTimeout(0);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    queued: 0,
    lanes: 0,
    internal: 0,
    classifier: 0,
  });
});

test("key quanta share two workers while internal and paid response permits remain separate", async () => {
  const scheduler = new PartnerScheduler(
    partnerCapacity(JSON.stringify(syntheticCapacity)),
  );
  const signal = new AbortController().signal;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = [
    scheduler.run("quiet", "paid", signal, () => gate),
    scheduler.run("quiet", "paid", signal, () => gate),
  ];
  const order: string[] = [];
  const paid = Array.from({ length: 2 }, () =>
    scheduler.run("quiet", "paid", signal, async () => {
      order.push("paid");
    }),
  );
  await assert.rejects(
    scheduler.run("quiet", "paid", signal, async () =>
      assert.fail("one key exceeded its bounded queue"),
    ),
  );
  const internal = scheduler.run("quiet", "internal", signal, async () => {
    order.push("internal");
  });
  release();
  await Promise.all([...active, ...paid, internal]);
  assert.ok(
    order.indexOf("internal") <= 1,
    "same-tenant internal key obtains a key quantum before the paid backlog drains",
  );
  const paidLanes = Array.from({ length: 4 }, () => scheduler.lane("quiet"));
  assert.throws(() => scheduler.lane("quiet"));
  const internalLanes = Array.from({ length: 4 }, () =>
    scheduler.lane("quiet", true),
  );
  assert.throws(
    () => scheduler.lane("noisy", true),
    "internal bound is fleet-scoped across configured tenants",
  );
  for (const done of [...paidLanes, ...internalLanes]) done();
  await setTimeout(0);
  assert.deepEqual(scheduler.snapshot(), {
    active: 0,
    queued: 0,
    lanes: 0,
    internal: 0,
    classifier: 0,
  });
});
