import assert from "node:assert/strict";
import test from "node:test";

import { verifySolanaExpiry } from "./solana-expiry.ts";

const expiry = { slot: 1_000, blockhash: "block-1000", lastValidBlockHeight: 650 };
const signature = "signed-transfer";
const slots = Array.from({ length: 151 }, (_, index) => 1_002 + index);

test("only the full linked finalized block window can prove expiry without a send", async () => {
  const cases = [
    { label: "full window with a skipped slot", expected: true },
    { label: "validity window is still open", expected: false, short: true },
    { label: "missing block", expected: false, missing: 15 },
    { label: "mismatched parent hash", expected: false, broken: 22 },
    { label: "signature in the last valid block", expected: false, landed: 149 },
  ];

  for (const spec of cases) {
    let requestedBlocks = 0;
    const request: typeof fetch = async (_url, init) => {
      const calls = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: [number, Record<string, unknown>] }>;
      assert.ok(calls.length <= 5, "each request has a bounded number of blocks");
      const replies = calls.map(({ method, id, params }) => {
        if (method === "getBlocksWithLimit") {
          assert.deepEqual(params, [1_001, 151, { commitment: "finalized" }]);
          return { jsonrpc: "2.0", id, result: spec.short ? slots.slice(0, -1) : slots };
        }
        assert.equal(method, "getBlock");
        assert.equal(params[1].transactionDetails, "signatures");
        assert.equal(params[1].commitment, "finalized");
        requestedBlocks += 1;
        const slot = params[0];
        const index = slots.indexOf(slot);
        const parentSlot = slots[index - 1] ?? expiry.slot;
        return { jsonrpc: "2.0", id, result: index === spec.missing ? null : {
          parentSlot,
          blockHeight: 501 + index,
          blockhash: `block-${slot}`,
          previousBlockhash: index === spec.broken ? "other-fork" : `block-${parentSlot}`,
          signatures: index === spec.landed ? [signature] : [],
        } };
      });
      return Response.json(replies.reverse());
    };
    assert.equal(await verifySolanaExpiry(expiry, signature, new AbortController().signal, request), spec.expected, spec.label);
    if (spec.short) assert.equal(requestedBlocks, 0, "wait for expiry before downloading blocks");
    if (spec.expected) assert.equal(requestedBlocks, 151, "every block through one past expiry is checked");
  }
});
