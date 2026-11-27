import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getEvmSwapApproveTxs, getSwapFromEvmTxPayload, type Quote } from "@mayanfinance/swap-sdk";
import { JsonRpcProvider } from "ethers";

import { assertFastMctpApproval, assertFastMctpPayload } from "./bridge-fast-mctp.ts";
import { guardQuote, type BridgeRequest } from "./bridge-guard.ts";
import { CHAINS, DESTINATIONS } from "./bridge-model.ts";

const QUOTE = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/fast-mctp-quote.json", import.meta.url), "utf8")) as Quote;
const NOW = Date.parse("2026-11-27T22:00:00Z");
const REQUEST: BridgeRequest = {
  chain: "base",
  token: CHAINS.base.tokens[1],
  to: DESTINATIONS[1],
  amountIn64: "20000000",
  blastAddress: `0x${"ab".repeat(32)}`,
  sourceAddress: `0x${"11".repeat(20)}`,
};

test("the Mayan SDK builds only the exact Base approval and Sui transfer accepted by the guard", async () => {
  const provider = new JsonRpcProvider("http://127.0.0.1:1", 8453, { staticNetwork: true });
  try {
    const { sourceAddress, blastAddress, amountIn64 } = REQUEST;
    const transaction = await getSwapFromEvmTxPayload(QUOTE, sourceAddress, blastAddress, null, sourceAddress, 8453, null, null, {
      evmProvider: provider,
      refundAddress: blastAddress,
    });
    const [approval] = await getEvmSwapApproveTxs(QUOTE, sourceAddress, provider);
    assertFastMctpPayload(transaction, QUOTE, REQUEST, NOW);
    assertFastMctpApproval(approval!, amountIn64);

    const tampered = { ...transaction, data: transaction.data!.replace("ab".repeat(32), "cd".repeat(32)) };
    assert.throws(() => assertFastMctpPayload(tampered, QUOTE, REQUEST, NOW), /transaction differs/);
    assert.throws(() => assertFastMctpPayload({ ...transaction, to: sourceAddress }, QUOTE, REQUEST, NOW), /transaction differs/);
    assert.throws(() => assertFastMctpApproval(approval!, "20000001"), /approval differs/);
  } finally {
    provider.destroy();
  }
});

test("Fast MCTP refuses changed terms, expired quotes and pairs requiring a swap", () => {
  assert.deepEqual(guardQuote(QUOTE, REQUEST, NOW), { ok: true });
  const refused = { ok: false, reason: "invalid Fast MCTP terms" };
  assert.deepEqual(guardQuote({ ...QUOTE, referrerBps: 1 }, REQUEST, NOW), refused);
  assert.deepEqual(guardQuote({ ...QUOTE, hasAuction: true }, REQUEST, NOW), refused);
  assert.deepEqual(guardQuote({ ...QUOTE, redeemRelayerFee64: "19000000" }, REQUEST, NOW), refused);
  assert.deepEqual(guardQuote(QUOTE, { ...REQUEST, amountIn64: "20000001" }, NOW), refused);
  assert.deepEqual(guardQuote(QUOTE, { ...REQUEST, to: DESTINATIONS[0] }, NOW), refused);
  assert.deepEqual(guardQuote(QUOTE, REQUEST, Date.parse("2026-11-28T00:00:00Z")), refused);
});
