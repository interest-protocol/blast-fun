import assert from "node:assert/strict";
import test from "node:test";
import { buildRewardManifest, rewardDigest } from "@interest-protocol/blast-core/rewards/allocations";
import { merkleNode } from "@interest-protocol/blast-core/merkle";
import { bcs } from "@mysten/sui/bcs";
import { toHex } from "@mysten/sui/utils";
import { base, deployment, id, key, round } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";
import { addressBalanceGas } from "../../../test/fixtures/modules/worker-runtime/address-balance-gas.ts";
import { fitClaimBatch, rewardClaimIntent } from "./claim-batch.ts";
import { rewardTransaction } from "./transactions.ts";

function manifestOf(count: number) {
  return buildRewardManifest({
    vaultId: base.vault.objectId,
    number: 0n,
    startCheckpoint: 10n,
    endCheckpoint: 20n,
    allocations: Array.from({ length: count }, (_, index) => ({
      beneficiary: id((index + 1).toString(16)),
      memeAmount: 2n * BigInt(index + 1),
      quoteAmount: BigInt(index + 1),
    })),
  });
}

async function signedLength(intent: ReturnType<typeof rewardClaimIntent>): Promise<number> {
  const transaction = rewardTransaction(deployment, intent);
  addressBalanceGas(transaction, {
    sender: key.toSuiAddress(),
    gasBudgetMist: 1_000_000_000n,
    chainIdentifier: deployment.chainIdentifier,
  });
  const bytes = await transaction.build();
  const { signature } = await key.signTransaction(bytes);
  return bcs.SenderSignedData.serialize([{
    intentMessage: {
      intent: { scope: { TransactionData: true }, version: { V0: true }, appId: { Sui: true } },
      value: bcs.TransactionData.parse(bytes),
    },
    txSignatures: [signature],
  }]).toBytes().byteLength;
}

test("a JOEY-sized round paying both assets fits in one PTB and smaller batches keep their original operation key", () => {
  const { allocations, ...summary } = manifestOf(182);
  const common = { ...base, kind: "claim" as const, round, manifest: { ...summary, leafCount: 182 } };
  const batch = fitClaimBatch(deployment, common, allocations);
  assert.deepEqual(batch.leaves, allocations);
  assert.equal(rewardClaimIntent(common, allocations.slice(0, 2)).operation, `${base.planId}:claim:0,1`);
});

test("maximum-depth proofs produce the largest prefix that fits the signed 128 KiB limit", async () => {
  const { allocations, ...summary } = manifestOf(256);
  // Embed the fixture's entire 256-leaf subtree at the far left of a depth-16 tree.
  const ancestors = Array.from({ length: 8 }, (_, i) => String(i + 1).repeat(64));
  const root = ancestors.reduce((node, sibling) => merkleNode(node, rewardDigest(sibling)), rewardDigest(summary.root));
  const leaves = allocations.map((leaf) => ({ ...leaf, proof: [...leaf.proof, ...ancestors] }));
  const common = {
    ...base,
    kind: "claim" as const,
    memeType: `${id("ee")}::me::MEME`,
    round,
    manifest: { ...summary, root: toHex(root), leafCount: 65_536 },
  };
  const batch = fitClaimBatch(deployment, common, leaves);
  assert.deepEqual(batch.leaves, leaves.slice(0, 171));
  assert.equal(await signedLength(batch), 130_337);
  assert.equal(await signedLength(rewardClaimIntent(common, leaves.slice(0, 172))), 131_097);
  assert.match(batch.operation, new RegExp(`^${base.planId}:claim:sha256:[a-f0-9]{64}$`));
  assert.equal(rewardClaimIntent(common, leaves.slice(0, 171)).operation, batch.operation);
  assert.notEqual(rewardClaimIntent(common, leaves.slice(1, 172)).operation, batch.operation);
});
