import { readLaunchCreation } from "@interest-protocol/blast-sdk/launchpad";
import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

import type { LaunchStepPlan } from "./store.ts";

export type PublishedLaunch = Readonly<{ launchId: string; memeType: string }>;
export type ReadPublishedLaunch = (saved: LaunchStepPlan, signal: AbortSignal) => Promise<PublishedLaunch | null>;

/** The successful transaction the server prepared with the draft's verified ticket. */
export async function readPublishedLaunch(client: ClientWithCoreApi, saved: LaunchStepPlan, signal: AbortSignal): Promise<PublishedLaunch | null> {
  try {
    const result = await client.core.getTransaction({ digest: saved.digest, include: { effects: true, objectTypes: true }, signal });
    if (result.$kind !== "Transaction" || result.Transaction.digest !== saved.digest) return null;
    const { launch, memeType } = readLaunchCreation(result.Transaction, saved.plan.launchpad_original_package_id);
    return { launchId: launch.objectId, memeType };
  } catch (error) {
    if (error instanceof TransactionError && error.reason === "notFound") return null;
    throw error;
  }
}

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
