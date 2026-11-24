import assert from "node:assert/strict";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

import { replacedWalletGas } from "./reconcile.ts";
import type { LaunchStepPlan } from "./store.ts";

const ID = `0x${"a".repeat(64)}`;
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OTHER = "11111111111111111111111111111111";

async function retained(): Promise<LaunchStepPlan> {
  const transaction = new Transaction();
  transaction.setSender(ID);
  transaction.setGasPayment([{ objectId: ID, version: "5", digest: DIGEST }]);
  return { digest: DIGEST, plan: { draft_id: "draft", version: 1, launchpad_original_package_id: ID, steps: [{ kind: "publish_coin", transaction: await transaction.toJSON() }] } };
}

function effect(version: string, inputDigest = DIGEST, transactionDigest = OTHER) {
  return { $kind: "Transaction", Transaction: { digest: transactionDigest, effects: { changedObjects: [{ objectId: ID, inputState: "Exists", inputVersion: version, inputDigest }] } } };
}

function node(pages: ReturnType<typeof effect>[][]): ClientWithCoreApi {
  return { core: {
    // No current-object lookup: gas may already be deleted or merged.
    getObject: async () => { throw new Error("gas coin was merged away"); },
    listTransactions: async ({ filter, before }: { filter: { sender: string }; before: string | null }) => {
      assert.equal(filter.sender, ID);
      const index = before === null ? 0 : Number(before);
      return { transactions: pages[index] ?? [], hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) };
    },
  } } as unknown as ClientWithCoreApi;
}

test("only another finalized transaction consuming the exact pinned reference permits replacement", async () => {
  const saved = await retained();
  assert.equal(await replacedWalletGas(node([[effect("5")]]), saved), true);
  assert.equal(await replacedWalletGas(node([[effect("5", DIGEST, DIGEST)]]), saved), false);
  assert.equal(await replacedWalletGas(node([[effect("6")]]), saved), false);
  assert.equal(await replacedWalletGas(node([[effect("5", OTHER)]]), saved), false);
});

test("recovery finds an earlier consumer after subsequent spends or merging the gas coin", async () => {
  const saved = await retained();
  assert.equal(await replacedWalletGas(node([[effect("7"), effect("6")], [effect("5")]]), saved), true);
  assert.equal(await replacedWalletGas(node([[], [effect("5")]]), saved), true, "scan-limited empty pages are followed");
  assert.equal(await replacedWalletGas(node([]), saved), false, "no proof never authorizes another mint");
});
