import assert from "node:assert/strict";
import test from "node:test";
import { partnerRecognitionNamespace } from "./recognition-namespace.ts";

const quota = "a".repeat(64);
const shared = "c".repeat(64);

test("recognition defaults to the quota namespace", () => {
  assert.equal(partnerRecognitionNamespace(undefined, quota), quota);
});

test("a shared registry override replaces the branch-specific quota namespace", () => {
  assert.equal(partnerRecognitionNamespace(shared, quota), shared);
});

test("an explicit recognition namespace rejects malformed configuration", () => {
  for (const namespace of ["", " ", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
    assert.throws(() => partnerRecognitionNamespace(namespace, quota), /Invalid partner recognition namespace/);
  }
});
