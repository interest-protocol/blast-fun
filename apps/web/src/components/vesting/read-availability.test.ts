import assert from "node:assert/strict";
import test from "node:test";
import { retryVestingRead, VestingCapabilityUnavailable } from "./read-availability";

test("indexing gaps do not promise immediate recovery while transient reads get bounded retries", () => {
  assert.equal(retryVestingRead(0, new VestingCapabilityUnavailable()), false);
  assert.equal(retryVestingRead(0, new Error("Offline")), true);
  assert.equal(retryVestingRead(2, new Error("Offline")), false);
});
