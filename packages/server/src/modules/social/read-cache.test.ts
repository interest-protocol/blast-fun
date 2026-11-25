import assert from "node:assert/strict";
import test from "node:test";
import { createReadCache } from "@blast/server/modules/social/read-cache.ts";

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
