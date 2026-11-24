// Generated fixture identities and key. No fixture holds value or contacts a node.
import { defineBlastDeployment, deploymentFingerprint } from "@interest-protocol/blast-deployments-sdk";
import { buildRewardManifest } from "@interest-protocol/blast-core/rewards/allocations";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "../../final-stack/non-production-deployment.ts";
import { addressBalanceGas } from "../worker-runtime/address-balance-gas.ts";
import { CLAIM_WINDOW_MS, frozenSchema } from "../../../../src/modules/reward-plan/plan.ts";
import { rewardTransaction, type RewardIntent } from "../../../../src/modules/vault-rewards/transactions.ts";

export const id = normalizeSuiAddress;
export const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
export const fingerprint = deploymentFingerprint(deployment);
export const key = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, i) => i + 81));
export const cap = { objectId: id("0xca"), version: "3", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" };
export const vault = { objectId: id("0xaa"), initialSharedVersion: "7" };
export const round = { objectId: id("0xbb"), initialSharedVersion: "8" };
export const memeType = `${id("0xee")}::meme::MEME`;
export const quoteType = `${id("0x2")}::sui::SUI`;
export const manifest = buildRewardManifest({ vaultId: vault.objectId, number: 0n, startCheckpoint: 10n, endCheckpoint: 20n, allocations: [{ beneficiary: id("0xd1"), memeAmount: 80n, quoteAmount: 100n }, { beneficiary: id("0xd2"), memeAmount: 20n, quoteAmount: 40n }] });
const summary = { version: manifest.version, vaultId: manifest.vaultId, number: manifest.number, startCheckpoint: manifest.startCheckpoint, endCheckpoint: manifest.endCheckpoint, root: manifest.root, manifestDigest: manifest.manifestDigest, memeAmount: manifest.memeAmount, quoteAmount: manifest.quoteAmount };
export const base = { planId: "10000000-0000-4000-8000-000000000001", fingerprint, operation: "schedule", memeType, quoteType, vault, manifest: { ...summary, leafCount: manifest.allocations.length }, storageHash: "a".repeat(64), treasury: id("0xcc"), reserve: "10" };
export const intents: RewardIntent[] = [
  { ...base, kind: "schedule_round", admin: cap, claimWindowMs: CLAIM_WINDOW_MS },
  { ...base, kind: "publish_round" },
  { ...base, kind: "claim", round, leaves: manifest.allocations },
  { ...base, kind: "settle_gas_reserve", round, admin: cap, reimbursement: "4", gasEffectsHash: "b".repeat(64), gasEffectCount: 3 },
  { ...base, kind: "close_round", round },
];
export const frozen = frozenSchema.parse({ network: "mainnet", fingerprint, vaultId: vault.objectId, memeType, quoteType, poolId: id("0xdd"), originId: id("0xef"), number: "0", startMs: "1000", endMs: "86401000", start: { checkpoint: "10", digest: cap.digest, timestampMs: "1000" }, end: { checkpoint: "20", digest: cap.digest, timestampMs: "86401000" }, roundStart: "10", exclusions: [], treasury: base.treasury, memePrice: { numerator: "1", denominator: "1", evidence: {} }, quotePrice: { numerator: "1", denominator: "1", evidence: {} }, grossMeme: "100", grossQuote: "150", reserve: "10", gasReserveBps: 666, claimWindowMs: CLAIM_WINDOW_MS, globalWeight: "10", qualifiers: 2, sourceEvidence: {} });
export async function bytes(intent: RewardIntent = intents[0]!, alter?: (tx: ReturnType<typeof rewardTransaction>) => void) {
  const tx = rewardTransaction(deployment, intent);
  addressBalanceGas(tx, { sender: key.toSuiAddress(), gasBudgetMist: 50_000_000n * BigInt(intent.kind === "claim" ? intent.leaves.length : 1), chainIdentifier: deployment.chainIdentifier });
  alter?.(tx);
  return tx.build();
}
