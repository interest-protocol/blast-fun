import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createReadCache, sharedLoad } from "@blast/server/modules/social/read-cache.ts";
import { createPublicReadCache } from "@blast/core/lib/public-read-cache.ts";
import type { RedisCommands } from "@blast/core/lib/redis.ts";
import { PUBLIC_READ_WAIT_MS } from "@blast/server/modules/public-reads/shared-runtime.ts";

test("in-flight reads coalesce even after their TTL, failed reads retry, and age never resets", async () => {
  let now = 0;
  const cache = createReadCache<number>(10_000, 2, () => now);
  const first = Promise.withResolvers<number>();
  let calls = 0;
  const load = () => { calls++; return first.promise; };
  const a = cache.read("a", load);
  now = 15_000;
  let age = 0;
  const b = cache.read("a", load, (value) => { age = value; });
  first.resolve(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  assert.equal(calls, 1);
  assert.equal(age, 15_000);
  assert.equal(await cache.read("a", async () => 8), 8);
  await assert.rejects(cache.read("bad", async () => { throw new Error("down"); }));
  assert.equal(await cache.read("bad", async () => 9), 9);
});

test("bounded entries evict old keys and clearing prevents completed or pending reuse", async () => {
  const cache = createReadCache<number>(10_000, 2);
  await cache.read("a", async () => 1);
  await cache.read("b", async () => 2);
  await cache.read("c", async () => 3);
  assert.equal(await cache.read("a", async () => 4), 4);
  const old = Promise.withResolvers<number>();
  const pending = cache.read("pending", () => old.promise);
  cache.clear();
  assert.equal(await cache.read("pending", async () => 5), 5);
  old.resolve(6);
  await pending;
  assert.equal(await cache.read("pending", async () => 7), 5);
});

test("concurrent misses load once, and past the TTL readers get the last good answer while one refresh runs", async () => {
  let now = 0;
  const cache = createReadCache<number>(10_000, 4, () => now, { ms: 20_000, label: "test" });
  let calls = 0;
  let next = Promise.withResolvers<number>();
  const load = () => { calls++; return next.promise; };
  const burst = () => Promise.all(Array.from({ length: 20 }, () => cache.read("home", load)));
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  const cold = burst();
  next.resolve(1);
  assert.deepEqual(new Set(await cold), new Set([1]));
  assert.equal(calls, 1, "twenty cold misses run one load");

  now = 15_000;
  next = Promise.withResolvers<number>();
  let age = 0;
  assert.deepEqual(new Set(await burst()), new Set([1]), "stale readers do not wait on the refresh");
  assert.equal(await cache.read("home", load, (ms) => { age = ms; }), 1);
  assert.equal(age, 15_000, "a stale answer reports its real age, so the route sends it no-store");
  assert.equal(calls, 2, "one refresh for the whole burst");
  next.reject(new Error("57014"));
  await settled();
  next = Promise.withResolvers<number>();
  assert.equal(await cache.read("home", load), 1, "a failed refresh keeps the last good answer");
  assert.equal(calls, 3, "and the next stale read starts one more refresh");
  next.resolve(2);
  await settled();
  assert.equal(await cache.read("home", load), 2, "a finished refresh replaces it");
  assert.equal(calls, 3);

  now = 15_000 + 30_000;
  next = Promise.withResolvers<number>();
  const blocked = burst();
  next.resolve(3);
  assert.deepEqual(new Set(await blocked), new Set([3]), "past the stale bound, readers wait for one fresh load");
  assert.equal(calls, 4);
});

test("a load slower than a second runs once for every process, and its answer expires ten seconds after the read began", async (t) => {
  let wall = 50_000;
  t.mock.method(Date, "now", () => wall);
  const values = new Map<string, string>();
  let contention = 0;
  const redis: RedisCommands = { execute: async (args) => {
    if (args[0] === "GET") return values.get(args[1]) ?? null;
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
    throw new Error("Unexpected command");
  } };
  const instance = () => ({
    cache: createReadCache<number>(10_000, 4, Date.now, { ms: 20_000, label: "test" }),
    shared: createPublicReadCache(redis, "test", "s".repeat(32), { waitMs: PUBLIC_READ_WAIT_MS.social }),
  });
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const read = (p: ReturnType<typeof instance>, age?: (ms: number) => void) =>
    p.cache.read("feed", sharedLoad(p.shared, "feed", async () => { reads++; await gate.promise; return reads; }), age);

  const [a, b, c] = [instance(), instance(), instance()];
  const first = read(a);
  let age = -1;
  const second = read(b, (ms) => { age = ms; });
  while (contention === 0) await setTimeout(1);
  await setTimeout(1_200); // past the one-second default wait
  wall += 1_500;
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(reads, 1, "the second process waits for the first one's slow read");
  assert.equal(age, 1_500, "and ages it from when that read began");

  wall += 8_600;
  await setTimeout(260); // past the 250 ms local tier
  assert.equal(await read(c), 2, "ten seconds after the read began, the shared answer is gone");
});
