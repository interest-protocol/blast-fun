import assert from "node:assert/strict";
import test from "node:test";
import { settledAll } from "./settled-all.ts";

test("first failure retains siblings and preserves the original error", async () => {
  const failure = new Error("first failure");
  let finish!: () => void;
  const sibling = new Promise<void>((resolve) => { finish = resolve; });
  let settled = false;
  const result = settledAll([Promise.reject(failure), sibling]).finally(() => { settled = true; });
  const rejected = assert.rejects(result, (error) => error === failure);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  finish();
  await rejected;
  assert.deepEqual(await settledAll([Promise.resolve(1), "two"]), [1, "two"]);
});
