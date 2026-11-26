import { z } from "zod";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { objectIdSchema, u64Schema, wholeNumberSetting } from "#workers/lib/validation.ts";
import { refuseForeignSignerKeys } from "#workers/modules/worker-runtime/keys.ts";
import { pricePolicyFromEnvironment } from "#workers/modules/reward-plan/prices.ts";
import type { PlannerSettings } from "./planner.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function addresses(environment: Environment, name: string): string[] {
  const message = `${name} must be canonical addresses.`;
  let parsed: unknown;
  try { parsed = JSON.parse(environment[name] ?? "[]"); } catch { throw new Error(message); }
  const result = z.array(objectIdSchema).max(1000).safeParse(parsed);
  if (!result.success) throw new Error(message);
  return [...new Set(result.data)].sort();
}

export function plannerSettingsFromEnvironment(environment: Environment): PlannerSettings {
  refuseForeignSignerKeys(environment, null);
  const deployment = expectedDeployment(environment);
  if (!deployment) throw new Error("BLAST_NETWORK=mainnet and BLAST_DEPLOYMENT_FINGERPRINT are required.");
  const noMinimumVaults = addresses(environment, "REWARDS_NO_MINIMUM_VAULTS");
  const catchUpAtMs = environment.REWARDS_CATCH_UP_AT_MS || null;
  if (catchUpAtMs !== null && (!u64Schema.safeParse(catchUpAtMs).success || noMinimumVaults.length === 0)) {
    throw new Error("REWARDS_CATCH_UP_AT_MS requires an epoch millisecond timestamp and REWARDS_NO_MINIMUM_VAULTS.");
  }
  return {
    fingerprint: deployment.deployment,
    gasReserveBps: wholeNumberSetting(environment, "REWARDS_GAS_RESERVE_BPS", 0, 0, 909),
    exclusions: addresses(environment, "REWARDS_EXCLUSIONS"),
    noMinimumVaults,
    catchUpAtMs,
    ...pricePolicyFromEnvironment(environment),
  };
}
