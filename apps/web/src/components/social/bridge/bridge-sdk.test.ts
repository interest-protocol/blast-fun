import assert from "node:assert/strict";
import test from "node:test";

import { explorerRows, mergeRows, type BridgeRow } from "./bridge-sdk.ts";

const BLAST = `0x${"ab".repeat(32)}`;
const swap = (hash: string, at: string, extra: Record<string, unknown> = {}) => ({
  sourceTxHash: hash, sourceChain: "30", destChain: "21", destAddress: BLAST.toUpperCase().replace("0X", "0x"),
  fromAmount: "20", fromTokenSymbol: "USDC", toAmount: "29.8", toTokenSymbol: "SUI", clientStatus: "COMPLETED", initiatedAt: at, ...extra,
});

test("explorer rows keep bridges paid to this Blast address on Sui, newest first", () => {
  const rows = explorerRows({ data: [
    swap("old", "2026-11-25T10:00:00Z"),
    swap("new", "2026-11-26T10:00:00Z", { sourceChain: "1", clientStatus: "INPROGRESS", toAmount: null }),
    swap("away", "2026-11-26T11:00:00Z", { destChain: "30" }),
    swap("other", "2026-11-26T12:00:00Z", { destAddress: `0x${"cd".repeat(32)}` }),
    { sourceTxHash: "broken" },
  ] }, BLAST);
  assert.deepEqual(rows.map((row) => [row.hash, row.chain, row.state, row.toAmount]), [["new", "solana", "pending", null], ["old", "base", "done", "29.8"]]);
  assert.deepEqual(explorerRows({ error: "rate limited" }, BLAST), []);
  const sources = explorerRows({ data: [swap("op", "2026-11-26T10:00:00Z", { sourceChain: "24" }), swap("pol", "2026-11-26T09:00:00Z", { sourceChain: "5" }), swap("bsc", "2026-11-26T08:00:00Z", { sourceChain: "4" })] }, BLAST);
  assert.deepEqual(sources.map((row) => [row.hash, row.chain]), [["op", "optimism"], ["pol", "polygon"], ["bsc", null]]);
});

test("a just-signed bridge stays first until the explorer lists it", () => {
  const listed = explorerRows({ data: [swap("a", "2026-11-26T10:00:00Z")] }, BLAST);
  const sent: BridgeRow = { ...listed[0]!, hash: "b", state: "pending", at: "2026-11-26T11:00:00Z" };
  assert.deepEqual(mergeRows([sent], listed).map((row) => row.hash), ["b", "a"]);
  assert.deepEqual(mergeRows([{ ...listed[0]!, state: "pending" }], listed).map((row) => row.state), ["done"]);
});
