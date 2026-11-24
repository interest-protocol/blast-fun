import assert from "node:assert/strict";
import test from "node:test";
import { mixedReadProfile } from "./mixed-read-profile.ts";

test("mixed profile counts every success, status, validation and transport failure with bounded telemetry", async () => {
  let now = 0;
  let calls = 0;
  let pauses = 0;
  const result = await mixedReadProfile({
    durationMs: 100,
    labels: ["partner"],
    sampleLimit: 2,
    clock: () => now,
    async pause() {
      pauses++;
    },
    random: () => 0.99,
    async request() {
      now += 25;
      switch (calls++) {
        case 0:
          return { status: 200 };
        case 1:
          return { status: 429 };
        case 2:
          return { status: 200, error: "validation" };
        default:
          throw new Error("Synthetic transport failure.");
      }
    },
  });
  assert.equal(calls, 4);
  assert.equal(pauses, 0);
  assert.equal(result.thinkTimeMs, 0);
  assert.equal(result.elapsedMs, 100);
  assert.equal(result.groups.partner.attempts, 4);
  assert.equal(result.groups.partner.valid, 1);
  assert.deepEqual(result.groups.partner.statuses, { 200: 2, 429: 1 });
  assert.deepEqual(result.groups.partner.errors, { http_status: 1, validation: 1, transport: 1 });
  assert.equal(result.groups.partner.latency.sampleCount, 2);
  assert.equal(result.groups.partner.latency.maxMs, 25);
  assert.equal(result.groups.partner.latency.p99Ms, 25);
});

test("paced profile excludes think time from latency and caps the final wait", async () => {
  let now = 0;
  const waits: number[] = [];
  const result = await mixedReadProfile({
    durationMs: 200,
    labels: ["partner"],
    thinkTimeMs: 60,
    clock: () => now,
    async pause(ms) {
      waits.push(ms);
      now += ms;
    },
    async request() {
      now += 25;
      return { status: 200 };
    },
  });
  assert.deepEqual(waits, [60, 60, 5]);
  assert.equal(result.elapsedMs, 200);
  assert.equal(result.thinkTimeMs, 60);
  assert.equal(result.groups.partner.attempts, 3);
  assert.equal(result.groups.partner.valid, 3);
  assert.equal(result.groups.partner.latency.p99Ms, 25);
  assert.equal(result.groups.partner.latency.meanMs, 25);
});

test("mixed profile rejects unbounded duration, clients and reservoirs before sending requests", async () => {
  let calls = 0;
  for (const change of [
    { durationMs: 0 },
    { durationMs: 120_001 },
    { labels: [] },
    { labels: Array(9).fill("user") },
    { sampleLimit: 4_097 },
    { thinkTimeMs: -1 },
    { thinkTimeMs: 120_001 },
    { thinkTimeMs: 1.5 },
  ]) {
    await assert.rejects(
      mixedReadProfile({
        durationMs: 1,
        labels: ["user"],
        ...change,
        async request() {
          calls++;
          return { status: 200 };
        },
      }),
      RangeError,
    );
  }
  assert.equal(calls, 0);
});
