import { createHash } from "node:crypto";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import type { RewardProof } from "@interest-protocol/blast-core/rewards/allocations";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import type { GasEstimate } from "#workers/modules/worker-runtime/attempt.ts";
import { ED25519_SIGNED_ENVELOPE_BYTES, MAX_REWARD_CLAIMS_PER_PTB, MAX_SUI_TRANSACTION_BYTES } from "./claim-limits.ts";
import { rewardTransaction, type RewardIntent } from "./transactions.ts";

type ClaimIntent = Extract<RewardIntent, { kind: "claim" }>;
type ClaimContext = Omit<ClaimIntent, "leaves" | "operation">;

// Sui bounds the signed envelope at 128 KiB. Address-balance TransactionData
// and ValidDuring add 140 bytes. Signing with one Ed25519 key adds 103 bytes.
const MAX_CLAIM_KIND_BYTES = MAX_SUI_TRANSACTION_BYTES - ED25519_SIGNED_ENVELOPE_BYTES - 140;

export function rewardClaimIntent(common: ClaimContext, leaves: readonly RewardProof[]): ClaimIntent {
  const indices = leaves.map((leaf) => leaf.index).join(",");
  const legacyOperation = `${common.planId}:claim:${indices}`;
  const operation =
    legacyOperation.length <= 512
      ? legacyOperation
      : `${common.planId}:claim:sha256:${createHash("sha256").update(indices).digest("hex")}`;
  return { ...common, leaves: [...leaves], operation };
}

/** The largest ordered prefix whose SDK-built PTB fits the signed size allowance. */
export function fitClaimBatch(
  deployment: BlastDeployment,
  common: ClaimContext,
  leaves: readonly RewardProof[],
): ClaimIntent {
  function fits(intent: ClaimIntent): boolean {
    const data = rewardTransaction(deployment, intent).getData();
    const bytes = TransactionDataBuilder.restore(data).build({ onlyTransactionKind: true });
    return bytes.byteLength <= MAX_CLAIM_KIND_BYTES;
  }

  let high = Math.min(leaves.length, MAX_REWARD_CLAIMS_PER_PTB);
  if (high === 0) {
    throw new Error("A reward claim batch needs at least one leaf.");
  }
  const largest = rewardClaimIntent(common, leaves.slice(0, high));
  if (fits(largest)) {
    return largest;
  }

  let low = 0;
  let best: ClaimIntent | undefined;
  high -= 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = rewardClaimIntent(common, leaves.slice(0, middle));
    if (fits(candidate)) {
      low = middle;
      best = candidate;
    } else {
      high = middle - 1;
    }
  }
  if (!best) {
    throw new Error("A single reward claim exceeds the Sui transaction size limit.");
  }
  return best;
}


/** Find the biggest affordable prefix before creating any payout custody. */
export async function fitClaimGas(
  common: ClaimContext,
  largest: ClaimIntent,
  estimate: (intent: ClaimIntent) => Promise<GasEstimate>,
): Promise<{ intent: ClaimIntent; budgetMist: bigint } | null> {
  let low = 0;
  let high = largest.leaves.length;
  let best = null;
  let candidate = largest;
  for (;;) {
    const gas = await estimate(candidate);
    if (gas.kind === "unavailable") return null;
    if (gas.kind === "simulation-failed") throw new Error("Reward claim gas simulation failed.");
    if (gas.kind === "fits") {
      best = { intent: candidate, budgetMist: gas.budgetMist };
      low = candidate.leaves.length;
    } else {
      high = candidate.leaves.length - 1;
    }
    if (low >= high) break;
    const middle = Math.ceil((low + high) / 2);
    candidate = rewardClaimIntent(common, largest.leaves.slice(0, middle));
  }
  if (!best) throw new Error("A single reward claim exceeds the available transaction gas or size limit.");
  return best;
}
