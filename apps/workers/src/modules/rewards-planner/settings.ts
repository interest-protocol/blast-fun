import { z } from "zod";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { objectIdSchema, wholeNumberSetting } from "#workers/lib/validation.ts";
import { refuseForeignSignerKeys } from "#workers/modules/worker-runtime/keys.ts";
import { pricePolicyFromEnvironment } from "#workers/modules/reward-plan/prices.ts";
import type { PlannerSettings } from "./planner.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function plannerSettingsFromEnvironment(environment: Environment): PlannerSettings {
  refuseForeignSignerKeys(environment, null);
  const deployment = expectedDeployment(environment);
  if (!deployment) throw new Error("BLAST_NETWORK=mainnet and BLAST_DEPLOYMENT_FINGERPRINT are required.");
  let parsed: unknown;
  try { parsed = JSON.parse(environment.REWARDS_EXCLUSIONS ?? "[]"); } catch { throw new Error("REWARDS_EXCLUSIONS must be canonical wallet addresses."); }
  const exclusions = z.array(objectIdSchema).max(1000).safeParse(parsed);
  if (!exclusions.success) throw new Error("REWARDS_EXCLUSIONS must be canonical wallet addresses.");
  return { fingerprint: deployment.deployment, gasReserveBps: wholeNumberSetting(environment, "REWARDS_GAS_RESERVE_BPS", 0, 0, 909), exclusions: [...new Set(exclusions.data)].sort(), ...pricePolicyFromEnvironment(environment) };
}
