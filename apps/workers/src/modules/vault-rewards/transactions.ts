import { z } from "zod";
import { Transaction, TransactionDataBuilder, Inputs } from "@mysten/sui/transactions";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { vaultDeployment } from "@interest-protocol/blast-deployments-sdk";
import { VaultTransactions } from "@interest-protocol/blast-vault-sdk/transactions";
import { rewardDigest, validateRewardManifestSummary, verifyRewardSummaryProof, type RewardManifestSummary } from "@interest-protocol/blast-core/rewards/allocations";
import { objectIdSchema, u64Schema, hashSchema, canonicalCoinSchema } from "#workers/lib/validation.ts";
import { SignerRefusal } from "#workers/modules/worker-runtime/signer.ts";
import { MAX_REWARD_CLAIMS_PER_PTB } from "./claim-limits.ts";
import { CLAIM_WINDOW_MS } from "#workers/modules/reward-plan/plan.ts";

const shared = z.object({ objectId: objectIdSchema, initialSharedVersion: u64Schema });
const owned = z.object({ objectId: objectIdSchema, version: u64Schema, digest: z.string().min(32).max(44) });
const proof = z.object({ index: u64Schema, beneficiary: objectIdSchema, memeAmount: u64Schema, quoteAmount: u64Schema, proof: z.array(hashSchema).max(16) });
const summary = z.object({ version: z.literal(2), vaultId: objectIdSchema, number: u64Schema, startCheckpoint: u64Schema, endCheckpoint: u64Schema, root: hashSchema, manifestDigest: hashSchema, memeAmount: u64Schema, quoteAmount: u64Schema, leafCount: z.number().int().min(1).max(65536) });
const base = { planId: z.string().uuid(), fingerprint: hashSchema, operation: z.string().min(1).max(512), memeType: canonicalCoinSchema, quoteType: canonicalCoinSchema, vault: shared, manifest: summary, storageHash: hashSchema, treasury: objectIdSchema, reserve: u64Schema };
const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("schedule_round"), admin: owned, claimWindowMs: z.literal(CLAIM_WINDOW_MS) }),
  z.strictObject({ ...base, kind: z.literal("publish_round") }),
  z.strictObject({ ...base, kind: z.literal("claim"), round: shared, leaves: z.array(proof).min(1).max(MAX_REWARD_CLAIMS_PER_PTB) }),
  z.strictObject({ ...base, kind: z.literal("settle_gas_reserve"), round: shared, admin: owned, reimbursement: u64Schema, gasEffectsHash: hashSchema, gasEffectCount: z.number().int().positive() }),
  z.strictObject({ ...base, kind: z.literal("close_round"), round: shared }),
]);
export type RewardIntent = z.infer<typeof intentSchema>;
export function parseRewardIntent(value: unknown): RewardIntent {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) throw new SignerRefusal("malformed vault rewards intent");
  const i = parsed.data;
  const m = validateRewardManifestSummary(i.manifest);
  if (m.vaultId !== i.vault.objectId || BigInt(i.reserve) * 10n > BigInt(m.quoteAmount)) throw new SignerRefusal("invalid vault reward commitment or reserve");
  if (i.kind === "claim") {
    const seen = new Set<string>();
    for (const leaf of i.leaves) {
      if (seen.has(leaf.index) || !verifyRewardSummaryProof(m, leaf)) throw new SignerRefusal("invalid vault reward leaf or proof");
      seen.add(leaf.index);
    }
  }
  if (i.kind === "settle_gas_reserve" && BigInt(i.reimbursement) > BigInt(i.reserve)) throw new SignerRefusal("gas reimbursement exceeds original reserve");
  return i;
}
export function rewardTransaction(deployment: BlastDeployment, value: unknown): Transaction {
  const i = parseRewardIntent(value), calls = new VaultTransactions(vaultDeployment(deployment));
  const common = { vault: i.vault, memeType: i.memeType, quoteType: i.quoteType };
  let tx: Transaction;
  if (i.kind === "schedule_round") tx = calls.scheduleRound({ ...common, adminCapId: i.admin.objectId, number: BigInt(i.manifest.number), startCheckpoint: BigInt(i.manifest.startCheckpoint), endCheckpoint: BigInt(i.manifest.endCheckpoint), root: rewardDigest(i.manifest.root), manifestDigest: rewardDigest(i.manifest.manifestDigest), leafCount: BigInt(i.manifest.leafCount), memeAmount: BigInt(i.manifest.memeAmount), quoteAmount: BigInt(i.manifest.quoteAmount), gasReserveAmount: BigInt(i.reserve), claimWindowDurationMs: BigInt(i.claimWindowMs), expectedTreasury: i.treasury });
  else if (i.kind === "publish_round") tx = calls.publishRound(common);
  else if (i.kind === "claim") tx = calls.claimRewards({ memeType: i.memeType, quoteType: i.quoteType, round: i.round, leaves: i.leaves.map((leaf) => ({ index: BigInt(leaf.index), beneficiary: leaf.beneficiary, memeAmount: BigInt(leaf.memeAmount), quoteAmount: BigInt(leaf.quoteAmount), proof: leaf.proof.map(rewardDigest) })) });
  else if (i.kind === "settle_gas_reserve") tx = calls.settleGasReserve({ ...common, round: i.round, adminCapId: i.admin.objectId, reimbursementAmount: BigInt(i.reimbursement) });
  else tx = calls.closeRound({ ...common, round: i.round });
  // Resolving only the configured immutable cap makes reconstruction entirely offline.
  if ("admin" in i) {
    const data = tx.getData();
    data.inputs = data.inputs.map((input) => input.UnresolvedObject?.objectId === i.admin.objectId ? Inputs.ObjectRef(i.admin) : input);
    return Transaction.from(JSON.stringify(data));
  }
  return tx;
}
export function sameRewardKind(bytes: Uint8Array, deployment: BlastDeployment, intent: RewardIntent): boolean {
  const expected = TransactionDataBuilder.restore(rewardTransaction(deployment, intent).getData()).build({ onlyTransactionKind: true });
  const actual = TransactionDataBuilder.restore(Transaction.from(bytes).getData()).build({ onlyTransactionKind: true });
  return Buffer.from(expected).equals(actual);
}
export function manifestSummary(value: unknown): RewardManifestSummary { return validateRewardManifestSummary(summary.parse(value)); }
