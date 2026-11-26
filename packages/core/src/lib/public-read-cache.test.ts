import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { createPublicReadCache } from "./public-read-cache.ts";
import type { RedisCommands } from "./redis.ts";

/** A command-level fixture: signed envelopes are made by the production writer. */
function fixture() {
  const values = new Map<string, string>();
  let gets = 0;
  let contention = 0;
  const redis: RedisCommands = { execute: async (args) => {
    if (args[0] === "GET") { gets++; return values.get(args[1]) ?? null; }
    if (args[0] === "SET") {
      if (values.has(args[1])) { contention++; return null; }
      values.set(args[1], args[2]);
      return "OK";
    }
    if (args[0] === "EVALSHA" && args[2] === "2") {
      if (values.get(args[3]) !== args[5]) return 0;
      values.set(args[4], args[6]);
      values.delete(args[3]);
      return 1;
    }
    if (args[0] === "EVALSHA" && args[2] === "1") {
      if (values.get(args[3]) === args[4]) values.delete(args[3]);
      return 1;
    }
    throw new Error("Unexpected fixture command");
  } };
  return { redis, values, gets: () => gets, contention: () => contention, read: createPublicReadCache(redis, "test", "s".repeat(32)) };
}

for (const failure of [false, true]) {
  test(`a contender promptly retries after its cache writer returns ${failure ? "an error" : "null"}`, { timeout: 2_000 }, async () => {
    const { read, redis, contention } = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const first = read("list", async () => {
      await waiting;
      if (failure) throw new Error("Synthetic source unavailable");
      return null;
    }, 1_000);
    // Attach before releasing, so the failure never becomes an unhandled rejection.
    const firstResult = first.catch((error: unknown) => error);
    const secondRead = createPublicReadCache(redis, "test", "s".repeat(32));
    const second = secondRead("list", async () => "recovered", 1_000);
    while (contention() === 0) await setTimeout(1);
    const started = performance.now();
    release();
    const initial = await firstResult;
    assert.ok(failure ? initial instanceof Error : initial === null);
    assert.equal(await second, "recovered");
    assert.ok(performance.now() - started < 400, "A released lease must not cost the full one-second wait budget");
    assert.equal(await read("list", async () => assert.fail("Recovered result must be cached"), 1_000), "recovered");
  });
}

test("a stuck writer still has a bounded wait and its contender cannot publish without ownership", { timeout: 2_000 }, async () => {
  const { read, redis, values, contention } = fixture();
  let release!: () => void;
  const first = read("list", () => new Promise<null>((resolve) => { release = () => resolve(null); }), 1_000);
  const other = createPublicReadCache(redis, "test", "s".repeat(32));
  const started = performance.now();
  const fallback = other("list", async () => "fallback", 1_000);
  while (contention() === 0) await setTimeout(1);
  const lock = [...values.entries()].find(([key]) => key.endsWith(":loading"))!;
  assert.equal(await fallback, "fallback");
  assert.ok(performance.now() - started < 1_500);
  assert.equal(values.get(lock[0]), lock[1], "A waiting reader must not steal or release the owner's lease");
  assert.equal(values.size, 1, "Without ownership the fallback must not enter Redis or completed local retention");
  release();
  assert.equal(await first, null);
  assert.equal(await other("list", async () => "fresh", 1_000), "fresh");
});

test("a delayed cache miss does not start another lease command after the wait deadline", async (t) => {
  let monotonic = 0;
  let gets = 0;
  const leaseAttempts: number[] = [];
  t.mock.method(performance, "now", () => monotonic);
  const read = createPublicReadCache({ execute: async (args) => {
    if (args[0] === "GET" && ++gets === 2) monotonic = 1_001;
    if (args[0] === "SET") leaseAttempts.push(monotonic);
    return null;
  } }, "test", "s".repeat(32));
  assert.equal(await read("list", async () => "bounded fallback", 1_000), "bounded fallback");
  assert.deepEqual(leaseAttempts, [0], "A GET that used the remaining budget must go straight to the source");
});

test("completed public hits avoid Redis without retaining earlier consumer mutations", async () => {
  const { read, gets } = fixture();
  let loads = 0;
  const load = async () => ({ nested: { value: ++loads } });
  await read("list", load, 1_000);
  const first = await read("list", load, 1_000); // Redis verifies before local retention.
  first.nested.value = 100;
  const commands = gets();
  for (let i = 0; i < 20; i++) assert.equal((await read("list", load, 1_000)).nested.value, 1);
  assert.equal(gets(), commands);
  assert.equal(loads, 1);
  assert.equal((await read("list", load, 0)).nested.value, 2, "TTL zero must bypass completed entries");
});

test("local hits have a non-sliding monotonic deadline and retain the signed expiry", async (t) => {
  let wall = 100_000;
  let monotonic = 0;
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => monotonic);
  const { read, gets } = fixture();
  let loads = 0;
  const load = async () => ++loads;
  await read("list", load, 1_000);
  await read("list", load, 1_000);
  const commands = gets();
  monotonic = 249;
  wall -= 10_000;
  assert.equal(await read("list", load, 1_000), 1);
  assert.equal(gets(), commands);
  monotonic = 250;
  assert.equal(await read("list", load, 1_000), 1);
  assert.equal(gets(), commands + 1, "Clock rollback and hits cannot extend the local deadline");
  wall = 101_000;
  monotonic = 251;
  assert.equal(await read("list", load, 1_000), 2, "An original signed expiry also ends a warm entry");
});

test("retention is bounded by entry count and UTF-16 string bytes", async (t) => {
  t.mock.method(performance, "now", () => 0);
  for (const [entries, payload] of [[129, "small"], [6, "x".repeat(400_000)]] as const) {
    const { read, gets } = fixture();
    for (let i = 0; i < entries; i++) {
      await read(String(i), async () => payload, 10_000);
      await read(String(i), async () => assert.fail("Expected a signed Redis value"), 10_000);
    }
    const commands = gets();
    assert.equal(await read("0", async () => assert.fail("Eviction must recheck Redis"), 10_000), payload);
    assert.equal(gets(), commands + 1, "The oldest payload must be evicted at either bound");
  }
});

test("warm readers retain only previously authenticated data for at most 250 ms after tampering", async (t) => {
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  const { read, redis, values } = fixture();
  const load = async () => "trusted";
  await read("list", load, 1_000);
  await read("list", load, 1_000);
  const key = [...values.keys()].find((key) => !key.endsWith(":loading"))!;
  const envelope = JSON.parse(values.get(key)!);
  values.set(key, JSON.stringify({ ...envelope, payload: JSON.stringify("forged") }));
  assert.equal(await read("list", load, 1_000), "trusted");
  const fresh = createPublicReadCache(redis, "test", "s".repeat(32));
  await assert.rejects(fresh("list", async () => { throw new Error("Source unavailable"); }, 1_000), /Source unavailable/);
  monotonic = 250;
  await assert.rejects(read("list", async () => { throw new Error("Source unavailable"); }, 1_000), /Source unavailable/);
  assert.equal(await read("list", async () => "recovered", 1_000), "recovered");
});

test("nulls, source failures and cache outages do not gain completed local retention", async () => {
  const { read } = fixture();
  let missing = 0;
  for (let i = 0; i < 2; i++) assert.equal(await read("missing", async () => { missing++; return null; }, 1_000), null);
  assert.equal(missing, 2);
  let failures = 0;
  for (let i = 0; i < 2; i++) await assert.rejects(read("failed", async () => { failures++; throw new Error("Unavailable"); }, 1_000));
  assert.equal(failures, 2);
  let loads = 0;
  const unavailable = createPublicReadCache({ execute: async () => { throw new Error("Cache unavailable"); } }, "test", "s".repeat(32));
  for (let i = 1; i <= 2; i++) assert.equal(await unavailable("list", async () => ++loads, 1_000), i);
});

test("successful cache metrics are sampled by tier while unavailable signals remain complete", async (t) => {
  const previous = process.env.MISSION_CONTROL_METRICS;
  delete process.env.MISSION_CONTROL_METRICS;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
  });
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => { records.push(JSON.parse(line)); });
  let random = 0.5;
  t.mock.method(Math, "random", () => random);
  const { read, redis } = fixture();
  await read("list", async () => "data", 1_000);
  await read("list", async () => assert.fail("Expected cache hit"), 1_000);
  await read("list", async () => assert.fail("Expected local hit"), 1_000);
  assert.equal(records.length, 0);
  random = 0;
  await read("list", async () => assert.fail("Expected local hit"), 1_000);
  await createPublicReadCache(redis, "test", "s".repeat(32))("list", async () => assert.fail("Expected Redis hit"), 1_000);
  random = 0.5;
  const unavailable = createPublicReadCache({ execute: async () => { throw new Error("Cache unavailable"); } }, "test", "s".repeat(32));
  await unavailable("list", async () => "fallback", 1_000);
  assert.deepEqual(records.map(({ outcome, tier, sampleRate }) => ({ outcome, tier, sampleRate })), [
    { outcome: "hit", tier: "local", sampleRate: 0.02 },
    { outcome: "hit", tier: "redis", sampleRate: 0.02 },
    { outcome: "unavailable", tier: undefined, sampleRate: undefined },
  ]);
});

test("an answer expires ttl after it was stored, or after its read began only when the cache opts in", async (t) => {
  let wall = 100_000;
  t.mock.method(Date, "now", () => wall);
  for (const expireFromReadStart of [false, true]) {
    const { redis } = fixture();
    const slow = async () => { wall += 1_500; return "slow"; };
    assert.equal(await createPublicReadCache(redis, "test", "s".repeat(32), { expireFromReadStart })("list", slow, 1_000), "slow");
    let loads = 0;
    const other = createPublicReadCache(redis, "test", "s".repeat(32), { expireFromReadStart });
    await other("list", async () => { loads++; return "again"; }, 1_000);
    assert.equal(loads, expireFromReadStart ? 1 : 0, "a slow short-TTL read stays shared unless the cache opts in");
  }
});
