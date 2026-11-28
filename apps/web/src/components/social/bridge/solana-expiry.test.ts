import assert from "node:assert/strict";
import test from "node:test";

import { verifySolanaExpiry } from "./solana-expiry.ts";

const expiry = { slot: 1_000, blockhash: "block-1000", lastValidBlockHeight: 650 };
const signature = "signed-transfer";
const slots = Array.from({ length: 151 }, (_, index) => 1_002 + index);

test("only the full linked finalized block window can prove expiry without a send", async () => {
  const cases = [
    { label: "full window with a skipped slot", expected: "failed" },
    { label: "validity window is still open", expected: "pending", short: true },
    { label: "missing block", expected: "pending", missing: 15 },
    { label: "mismatched parent hash", expected: "pending", broken: 22 },
    { label: "successful signature in the last valid block", expected: "confirmed", landed: 149, err: null },
    { label: "finalized failing receipt despite a missing status", expected: "failed", landed: 3, err: "AccountNotFound" },
    { label: "missing receipt metadata", expected: "pending", landed: 3 },
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
        assert.equal(params[1].commitment, "finalized");
        const slot = params[0];
        const index = slots.indexOf(slot);
        if (params[1].transactionDetails === "accounts") {
          assert.equal(index, spec.landed, "read the receipt from the matching block only");
          assert.equal(params[1].maxSupportedTransactionVersion, 1, "a v1 transaction elsewhere in the block must not hide the receipt");
          return { jsonrpc: "2.0", id, result: {
            blockhash: `block-${slot}`,
            transactions: [{ transaction: { signatures: [signature] }, meta: { err: spec.err } }],
          } };
        }
        assert.equal(params[1].transactionDetails, "signatures");
        requestedBlocks += 1;
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
    if (spec.expected === "failed" && spec.landed === undefined) assert.equal(requestedBlocks, 151, "every block through one past expiry is checked");
  }
});
