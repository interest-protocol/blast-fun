import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { deploymentFingerprint, type BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { loadSignerKey } from "#workers/modules/worker-runtime/keys.ts";
import { assertAddressBalanceEnvelope, SignerRefusal, gasBudgetFor, type SignedTransaction } from "#workers/modules/worker-runtime/signer.ts";
import { parseRewardIntent, sameRewardKind } from "./transactions.ts";
import { ED25519_SIGNED_ENVELOPE_BYTES, MAX_SUI_TRANSACTION_BYTES, REWARD_CLAIM_GAS_LIMIT_MIST } from "./claim-limits.ts";

export type RewardsSigner = { address: string; sign(bytes: Uint8Array, intent: unknown, deployment: BlastDeployment, beforeCrypto?: () => Promise<void>): Promise<SignedTransaction> };
export function createRewardsSigner(key: Ed25519Keypair, adminCapId: string, gasBudgetMist: bigint): RewardsSigner {
  const address = key.toSuiAddress();
  return {
    address,
    async sign(bytes, value, deployment, beforeCrypto) {
      const i = parseRewardIntent(value);
      if (i.kind === "claim" && bytes.length + ED25519_SIGNED_ENVELOPE_BYTES > MAX_SUI_TRANSACTION_BYTES) {
        throw new SignerRefusal("vault rewards claim exceeds the Sui transaction size limit");
      }
      const budget = i.kind === "claim" ? REWARD_CLAIM_GAS_LIMIT_MIST : gasBudgetFor(gasBudgetMist, 1);
      assertAddressBalanceEnvelope(bytes, { sender: address, gasBudgetMist: budget, chainIdentifier: deployment.chainIdentifier });
      if (deploymentFingerprint(deployment) !== i.fingerprint) throw new SignerRefusal("foreign deployment");
      if ("admin" in i && normalizeSuiAddress(i.admin.objectId) !== normalizeSuiAddress(adminCapId)) throw new SignerRefusal("foreign RewardsAdmin capability");
      if (!sameRewardKind(bytes, deployment, i)) throw new SignerRefusal("vault rewards bytes differ from the exact SDK transaction");
      if (!beforeCrypto) throw new SignerRefusal("missing durable reward signing barrier");
      await beforeCrypto();
      const signed = await key.signTransaction(bytes);
      return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), signature: signed.signature };
    },
  };
}
export function rewardsSignerFromEnvironment(environment: Readonly<Record<string, string | undefined>>, adminCapId: string, gasBudgetMist: bigint): RewardsSigner {
  return createRewardsSigner(loadSignerKey(environment, "VAULT_REWARDS_SIGNER_KEY"), adminCapId, gasBudgetMist);
}
