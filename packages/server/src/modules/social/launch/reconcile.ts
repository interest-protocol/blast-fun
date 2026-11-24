import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

import type { LaunchStepPlan } from "./store.ts";

/** Only an effect proving consumption of the exact reference can invalidate a retained plan. */
function consumed(effects: SuiClientTypes.TransactionEffects, reference: Readonly<{ objectId: string; version: string | number; digest: string }>): boolean {
  return effects.changedObjects.some((change) => change.objectId === reference.objectId
    && change.inputState === "Exists" && change.inputVersion === String(reference.version) && change.inputDigest === reference.digest);
}

function historyProof(entries: SuiClientTypes.ListTransactionsResponse<{ effects: true }>["transactions"], saved: LaunchStepPlan, references: readonly Readonly<{ objectId: string; version: string | number; digest: string }>[]): "original" | "replaced" | null {
  for (const entry of entries) {
    const transaction = entry.$kind === "Transaction" ? entry.Transaction : entry.FailedTransaction;
    if (transaction.digest === saved.digest) return "original";
    if (transaction.effects && references.some((reference) => consumed(transaction.effects, reference))) return "replaced";
  }
  return null;
}

/**
 * A different finalized transaction using a pinned gas input makes the old
 * bytes impossible to execute. Search history rather than the current gas
 * object: the owner may have spent it repeatedly or merged it away.
 * Missing/pruned proof keeps the retained plan; an RPC miss never permits a
 * second mint. Bound recovery work to ten pages and eight seconds per retry.
 */
export async function replacedWalletGas(client: ClientWithCoreApi, saved: LaunchStepPlan): Promise<boolean> {
  const data = Transaction.from(saved.plan.steps[0].transaction).getData();
  const references = data.gasData.payment ?? [];
  const sender = data.gasData.owner ?? data.sender;
  if (!sender || references.length === 0) return false;
  const signal = AbortSignal.timeout(8_000);
  let before: string | null = null;
  for (let page = 0; page < 10; page++) {
    const result: SuiClientTypes.ListTransactionsResponse<{ effects: true }> = await client.core.listTransactions({ filter: { sender }, include: { effects: true }, limit: 50, order: "descending", before, signal });
    const proof = historyProof(result.transactions, saved, references);
    if (proof !== null) return proof === "replaced";
    if (!result.hasNextPage || !result.endCursor || result.endCursor === before) break;
    before = result.endCursor;
  }
  return false;
}
