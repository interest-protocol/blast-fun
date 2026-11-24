import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { poolSettingsFromEnvironment } from "@blast/core/modules/database/pool.ts";
import { autocommitRead, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { workerSecrets } from "#workers/modules/worker-runtime/log.ts";
import { trustedUrlSetting, workerConfigFromEnvironment } from "#workers/modules/worker-runtime/config.ts";
import { runWorker } from "#workers/modules/worker-runtime/bootstrap.ts";
import { pollUntilAborted } from "#workers/modules/worker-runtime/poll.ts";
import { evaluateWorkerAccess } from "#workers/modules/worker-runtime/deployment.ts";
import { chainIdentityChecker, type CheckIdentities } from "#workers/modules/reward-plan/beneficiaries.ts";
import { MissingRewardHistory } from "#workers/modules/reward-plan/evidence.ts";
import { settlementEvidence } from "#workers/modules/reward-plan/gas-settlement.ts";
import { frozenSchema, json, readPlan, type Plan } from "#workers/modules/reward-plan/plan.ts";
import { discoverPeriods, freezePeriod, fillIdentityGaps, qualifyPage, allocatePage, reservePlan } from "./planner.ts";
import { buildManifest, uploadManifest, immutableBlobStorage, type ImmutableManifestStorage } from "./manifest.ts";
import { errorLabel } from "@blast/core/lib/metrics.ts";
import { JOB_STALLED_AFTER_MS } from "#workers/modules/worker-runtime/alerts.ts";
import { plannerSettingsFromEnvironment } from "./settings.ts";
import { rewardsPlannerPooledUrl } from "./database.ts";
import type { Pool } from "pg";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import type { PlannerSettings } from "./planner.ts";

const NAME = "rewards-planner";

export async function plannerPass(pool: Pool, deployment: BlastDeployment, settings: PlannerSettings, storage: ImmutableManifestStorage, check: CheckIdentities, limit = 8, conditions?: Conditions): Promise<void> {
  await discoverPeriods(pool, settings, limit);
  const { rows: periods } = await autocommitRead<{ period_id: string }>(pool, "rewards-planner", "SELECT period_id FROM vault_reward_periods WHERE deployment_fingerprint=$1 AND status='planning' ORDER BY end_ms,period_id LIMIT $2", [settings.fingerprint, limit]);
  for (const period of periods) {
    try {
      const id = await freezePeriod(pool, deployment, settings, period.period_id);
      let p = await readPlan(pool, id);
      // Each pass performs one bounded accounting page per period.
      if (p.stage === "qualifying") await qualifyPage(pool, id, await fillIdentityGaps(pool, id, check));
      else if (p.stage === "allocating") await allocatePage(pool, id);
      else if (p.stage === "proofs") { await buildManifest(pool, id); await uploadManifest(pool, id, storage); }
      p = await readPlan(pool, id);
      if (p.stage === "uploaded") await reservePlan(pool, deployment, id);
      await conditions?.clear(period.period_id);
    } catch (error) { await conditions?.failed(period.period_id, error); }
  }
  await prepareGasSettlements(pool, settings.fingerprint, limit, conditions);
}

type Conditions = { failed(id: string, error: unknown): Promise<void>; clear(id: string): Promise<void> };

/**
 * Measures gas for each published round whose relaying is done: every leaf is claimed, or every open
 * leaf is held because it pays an object (the relay records those as `heldLeaves`).
 */
export async function prepareGasSettlements(pool: Pool, fingerprint: string, limit: number, conditions?: Conditions): Promise<void> {
  const { rows: settlements } = await autocommitRead<Plan>(pool, "rewards-planner", `SELECT p.* FROM vault_reward_plans p JOIN vault_reward_periods d USING(period_id)
    JOIN chain_read_v1.vault_rounds r ON r.vault_id=d.vault_id AND r.number=p.number
    WHERE d.deployment_fingerprint=$1 AND p.stage='published' AND NOT r.closed AND NOT r.gas_settled AND r.gas_reserve_amount>0
    AND (r.claimed_count=r.leaf_count OR r.leaf_count-r.claimed_count<=jsonb_array_length(p.inputs->'heldLeaves')) ORDER BY d.end_ms,p.plan_id LIMIT $2`, [fingerprint, limit]);
  for (const p of settlements) {
    try {
      const f = frozenSchema.parse(p.inputs), evidence = await settlementEvidence(pool, p.plan_id, BigInt(f.reserve));
      await withTransaction(pool, (tx) => tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET inputs=$2 WHERE plan_id=$1 AND stage='published' AND inputs=$3::jsonb", [p.plan_id, json({ ...(p.inputs as Record<string, unknown>), gasSettlement: evidence }), json(p.inputs)]));
      await conditions?.clear(p.plan_id);
    } catch (error) { await conditions?.failed(p.plan_id, error); }
  }
}

export async function runRewardsPlanner(environment: Readonly<Record<string, string | undefined>>, signal: AbortSignal): Promise<void> {
  const settings = plannerSettingsFromEnvironment(environment), databaseUrl = rewardsPlannerPooledUrl(environment);
  const config = workerConfigFromEnvironment(environment, { databaseUrl, pool: poolSettingsFromEnvironment(environment) });
  const webhookUrl = trustedUrlSetting(environment, "BLAST_WORKER_ALERT_WEBHOOK_URL", config.environment === "production");
  const token = environment.REWARDS_BLOB_TOKEN?.trim();
  if (!token) throw new Error("REWARDS_BLOB_TOKEN is required.");
  const secrets = workerSecrets(environment);
  const storage = immutableBlobStorage(token);

  await runWorker({ name: NAME, environment, config, secrets, webhookUrl }, signal, async ({ log, client, pool, alerts }) => {
    const graphql = new SuiGraphQLClient({ network: "mainnet", url: config.graphql.url });
    const check = chainIdentityChecker(graphql, client, (call) => call(AbortSignal.timeout(config.timings.providerTimeoutMs)));
    const conditions = {
      async failed(planId: string, error: unknown) {
        const details = { planId, error: errorLabel(error), reason: error instanceof MissingRewardHistory ? error.reason : "planning-evidence" };
        log("rewards_planner.blocked", details);
        await alerts.raise(`reward_planning:${planId}`, details, { graceMs: JOB_STALLED_AFTER_MS });
      },
      clear: (planId: string) => alerts.clear(`reward_planning:${planId}`),
    };
    const identity = await autocommitRead<{ current_user: string }>(pool, NAME, "SELECT current_user");
    if (identity.rows[0]?.current_user !== "blast_indexer") throw new Error("Rewards planner must connect as blast_indexer.");

    const pass = async () => {
      try {
        const access = await evaluateWorkerAccess(config, client);
        if (access.status === "enabled") {
          await plannerPass(pool, access.deployment, settings, storage, check, config.batchSize, conditions);
          await alerts.clear(`job_stalled:${NAME}`);
        } else {
          log("rewards_planner.blocked", { reason: access.reasons.join(",") });
          await alerts.raise(`job_stalled:${NAME}`, { state: "blocked", reasons: access.reasons.join(",") }, { graceMs: JOB_STALLED_AFTER_MS });
        }
      } catch (error) {
        log("rewards_planner.blocked", { reason: "pass-evidence", error: errorLabel(error) });
        await alerts.raise(`job_stalled:${NAME}`, { state: "failed", error: errorLabel(error) }, { graceMs: JOB_STALLED_AFTER_MS });
      }
      return config.timings.pollIntervalMs;
    };

    return { jobs: [NAME], run: (stop) => pollUntilAborted(stop, pass) };
  });
}
