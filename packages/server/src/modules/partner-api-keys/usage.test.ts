import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { PartnerKeySummary } from "./repository.ts";
import { readPartnerKeyUsage } from "./usage.ts";

const key: PartnerKeySummary = {
  id: "00000000-0000-4000-8000-000000000001",
  partner_id: "acme",
  label: "backend",
  issued_by: "operator:test",
  created_at: new Date(0),
  revoked_at: null,
  revoked_by: null,
  tier: "standard",
  requests_per_minute: null,
  requests_per_day: null,
  policy_updated_at: new Date(0),
  policy_updated_by: "operator:test",
};

function readSnapshot(value: unknown) {
  // The Redis branch must not fall back to a PostgreSQL query.
  const pool = {} as Pool;
  return readPartnerKeyUsage(pool, [key], {
    pepper: "test-pepper-at-least-thirty-two-characters",
    namespace: "test:quota",
    redis: { execute: async () => value },
  });
}

test("quota snapshots require the complete Redis array and safe nonnegative numeric counters", async () => {
  for (const value of [null, {}, [], [60, 1], [60, 1, 2, 3]]) {
    await assert.rejects(readSnapshot(value), /^Error: Invalid quota snapshot$/);
  }
  for (const value of [[60, "1", 2], [60, -1, 2], [60, 1.5, 2], [60, 1, Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(readSnapshot(value), /^Error: Invalid quota counters$/);
  }
  assert.deepEqual((await readSnapshot([60, 1, 2]))[key.id], {
    minute: 1,
    day: 2,
    observedAt: "1970-01-01T00:01:00.000Z",
    minuteResetsAt: "1970-01-01T00:02:00.000Z",
    dayResetsAt: "1970-01-02T00:00:00.000Z",
  });
});

test("quota reads overlap two batches at most, with no more than 100 active keys per batch", async () => {
  const keys = Array.from({ length: 350 }, (_, index) => ({ ...key, id: `key-${index}` }));
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const batches: number[] = [];
  const reading = readPartnerKeyUsage({} as Pool, [
    ...keys,
    { ...key, id: "internal", tier: "internal" },
    { ...key, id: "revoked", revoked_at: new Date(0) },
  ], {
    pepper: "test-pepper-at-least-thirty-two-characters",
    namespace: "test:quota",
    redis: { execute: async (args) => {
      const counters = Number(args[2]);
      batches.push(counters / 2);
      calls += 1;
      peak = Math.max(peak, ++active);
      await gate.promise;
      active -= 1;
      return [60, ...Array(counters).fill(1)];
    } },
  });
  let usage;
  try {
    await Promise.resolve();
    assert.equal(calls, 2, "Start two independent store reads without waiting for the first");
  } finally {
    gate.resolve();
    usage = await reading;
  }
  assert.equal(peak, 2);
  assert.deepEqual(batches, [100, 100, 100, 50]);
  assert.deepEqual(Object.keys(usage), keys.map((entry) => entry.id));
  assert.ok(Object.values(usage).every((entry) => entry.minute === 1 && entry.day === 1));
});

test("a failed quota batch stops queued reads and drains the other in-flight read before rejecting", async () => {
  const failure = new Error("quota store unavailable");
  const sibling = Promise.withResolvers<unknown>();
  const failed = Promise.withResolvers<void>();
  let calls = 0;
  let settled = false;
  const reading = readPartnerKeyUsage({} as Pool,
    Array.from({ length: 350 }, (_, index) => ({ ...key, id: `key-${index}` })), {
      pepper: "test-pepper-at-least-thirty-two-characters",
      namespace: "test:quota",
      redis: { execute: async () => {
        calls += 1;
        if (calls === 1) {
          failed.resolve();
          throw failure;
        }
        return sibling.promise;
      } },
    });
  const rejected = assert.rejects(reading, (error) => error === failure);
  void reading.then(() => { settled = true; }, () => { settled = true; });
  try {
    await failed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(settled, false, "Do not return while a sibling store read is still running");
  } finally {
    sibling.reject(new Error("later sibling failure"));
    await rejected;
  }
  assert.equal(calls, 2, "Do not read remaining batches after a store failure");
});

test("quota usage keeps input order when the second batch completes first", async () => {
  const keys = Array.from({ length: 200 }, (_, index) => ({ ...key, id: `key-${index}` }));
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  let calls = 0;
  const reading = readPartnerKeyUsage({} as Pool, keys, {
    pepper: "test-pepper-at-least-thirty-two-characters",
    namespace: "test:quota",
    redis: { execute: async () => ++calls === 1 ? first.promise : second.promise },
  });
  second.resolve([60, ...Array(200).fill(2)]);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    first.resolve([60, ...Array(200).fill(1)]);
  }
  const usage = await reading;
  assert.deepEqual(Object.keys(usage), keys.map((entry) => entry.id));
  assert.equal(usage["key-0"].minute, 1);
  assert.equal(usage["key-100"].minute, 2);
});
