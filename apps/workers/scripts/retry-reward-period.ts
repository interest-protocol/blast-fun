import { z } from "zod";
import { createRuntimePool, poolSettingsFromEnvironment } from "@blast/core/modules/database/pool.ts";
import { objectIdSchema } from "#workers/lib/validation.ts";
import { rewardsPlannerPooledUrl } from "#workers/modules/rewards-planner/database.ts";
import { retrySkippedPeriod } from "#workers/modules/rewards-planner/planner.ts";
import { plannerSettingsFromEnvironment } from "#workers/modules/rewards-planner/settings.ts";

const [vault, period, ...rest] = process.argv.slice(2);
const vaultId = objectIdSchema.safeParse(vault);
const periodId = z.uuid().safeParse(period);
if (!vaultId.success || !periodId.success || rest.length) {
  console.error("Pass the vault object ID and the skipped period UUID.");
  process.exitCode = 1;
} else {
  try {
    const { fingerprint } = plannerSettingsFromEnvironment(process.env);
    const pool = createRuntimePool(rewardsPlannerPooledUrl(), poolSettingsFromEnvironment(process.env), "retry-reward-period");
    try {
      const planId = await retrySkippedPeriod(pool, fingerprint, vaultId.data, periodId.data);
      console.log(`Queued reward plan ${planId} for allocation.`);
    } finally {
      await pool.end();
    }
  } catch {
    console.error("Could not queue this reward period. Check the planner connection and the frozen period state.");
    process.exitCode = 1;
  }
}
