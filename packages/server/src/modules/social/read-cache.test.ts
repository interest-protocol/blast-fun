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
