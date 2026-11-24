import { objectIdSchema, wholeNumberSetting } from "#workers/lib/validation.ts";
import { pricePolicyFromEnvironment, type PricePolicy } from "#workers/modules/reward-plan/prices.ts";
import { MAX_REWARD_CLAIMS_PER_PTB } from "./claim-limits.ts";

export type RewardsSettings = { adminCapId: string; relayBatch: number; pricePolicy: PricePolicy };

export function rewardsSettingsFromEnvironment(environment: Readonly<Record<string, string | undefined>>): RewardsSettings {
  const cap = objectIdSchema.safeParse(environment.VAULT_REWARDS_ADMIN_CAP_ID?.trim());
  if (!cap.success) throw new Error("VAULT_REWARDS_ADMIN_CAP_ID must be a canonical object ID.");
  return {
    adminCapId: cap.data,
    relayBatch: wholeNumberSetting(
      environment,
      "VAULT_REWARDS_RELAY_BATCH",
      MAX_REWARD_CLAIMS_PER_PTB,
      1,
      MAX_REWARD_CLAIMS_PER_PTB,
    ),
    pricePolicy: pricePolicyFromEnvironment(environment),
  };
}
