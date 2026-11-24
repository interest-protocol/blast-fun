import assert from "node:assert/strict";
import test from "node:test";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";

test("parallel public reads coalesce, completed detail reads stay fresh, failures retry", async () => {
  const read = createPublicPresaleReader();
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 100 }, () => read("detail:a", load, 0)),
    ),
    Array(100).fill(1),
  );
  assert.equal(await read("detail:a", load, 0), 2);
  const fail = async () => {
    throw new Error("offline");
  };
  await assert.rejects(read("list:a", fail, 10_000));
  assert.equal(await read("list:a", load, 10_000), 3);
});

test("list cache separates full queries, expires, and is bounded", async () => {
  let now = 0;
  const read = createPublicPresaleReader(() => now);
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await read("list:first", load, 10_000), 1);
  assert.equal(await read("list:first", load, 10_000), 1);
  assert.equal(await read("list:other", load, 10_000), 2);
  now = 10_000;
  assert.equal(await read("list:first", load, 10_000), 3);
  for (let i = 0; i < 501; i++) await read(`list:${i}`, load, 10_000);
  assert.equal(await read("list:first", load, 10_000), 505);
});
