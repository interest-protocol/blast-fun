import assert from "node:assert/strict";
import test from "node:test";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { readWalletBalances, type PortfolioFullnode } from "./balances.ts";

function stub(answer: (owner: string, coinType: string) => Promise<string>): PortfolioFullnode & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getBalance({ owner, coinType }) {
      calls.push(`${owner}|${coinType}`);
      return { balance: { balance: await answer(owner, coinType) } };
    },
  };
}

test("T-019-AC-3 (AC-112, AC-117): balances are one call per wallet per coin, summed; any failure fails the whole read", async () => {
  const wallets = ["0xa", "0xb", "0xc"];
  const node = stub(async (owner, coinType) => (coinType === PORTFOLIO_COIN_TYPES.sui ? { "0xa": "1", "0xb": "2", "0xc": "18446744073709551615" }[owner] ?? "0" : "7"));
  assert.deepEqual(await readWalletBalances(node, wallets), { sui: "18446744073709551618", usdc: "21" });
  assert.equal(node.calls.length, 6);
  assert.deepEqual(new Set(node.calls), new Set(wallets.flatMap((w) => [`${w}|${PORTFOLIO_COIN_TYPES.sui}`, `${w}|${PORTFOLIO_COIN_TYPES.usdc}`])));

  // No wallets: known zero, no calls.
  const empty = stub(async () => "1");
  assert.deepEqual(await readWalletBalances(empty, []), { sui: "0", usdc: "0" });
  assert.equal(empty.calls.length, 0);

  // One wallet failing fails the read rather than under-reporting.
  await assert.rejects(readWalletBalances(stub(async (owner) => (owner === "0xb" ? Promise.reject(new Error("down")) : "1")), wallets));
  for (const bad of ["-1", "1.5", "", "01"]) {
    await assert.rejects(readWalletBalances(stub(async () => bad), wallets), /malformed/, bad);
  }
  // Too slow: rejected at the deadline, and the calls are aborted.
  let aborted = 0;
  const slow: PortfolioFullnode = {
    getBalance: ({ signal }) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => {
        aborted += 1;
        reject(new Error("aborted"));
      })),
  };
  const started = Date.now();
  await assert.rejects(readWalletBalances(slow, ["0xa"], 50), /in time/);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(aborted, 2);
});
