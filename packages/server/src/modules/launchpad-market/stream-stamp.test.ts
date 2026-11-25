import assert from "node:assert/strict";
import test from "node:test";

import { stampRelay } from "./stream-relay.ts";

// This fails if the relay adds a hop to frames without engine hops, or breaks the 8-key cap the browser enforces.
test("the relay stamps relay_ms only beside engine hops, within 8 keys", () => {
  const hops = { arrived_ms: 1, picked_ms: 2 };
  assert.deepEqual(stampRelay({ type: "trade", provenance: { checkpoint: 5, hops } }, 9), {
    type: "trade", provenance: { checkpoint: 5, hops: { arrived_ms: 1, picked_ms: 2, relay_ms: 9 } },
  });
  const plain = { type: "trade", provenance: { checkpoint: 5 } };
  assert.equal(stampRelay(plain, 9), plain);
  const full = { type: "trade", provenance: { hops: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`h${i}`, i])) } };
  assert.equal(stampRelay(full, 9), full);
});
