import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { coreDeployment } from "@interest-protocol/blast-deployments-sdk";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import { workerSecrets } from "#workers/modules/worker-runtime/log.ts";
import { trustedUrlSetting, workerConfigFromEnvironment } from "#workers/modules/worker-runtime/config.ts";
import { evaluateWorkerAccess, type WorkerAccess } from "#workers/modules/worker-runtime/deployment.ts";
import { createWorker } from "#workers/modules/worker-runtime/runtime.ts";
import { boundedProvider } from "#workers/modules/worker-runtime/provider.ts";
import { runWorker } from "#workers/modules/worker-runtime/bootstrap.ts";
import { withWorkerReleaseGate } from "#workers/modules/worker-runtime/release-gate.ts";
import { adminCapStanding } from "#workers/modules/worker-runtime/admin.ts";
import { JOB_STALLED_AFTER_MS } from "#workers/modules/worker-runtime/alerts.ts";
import { chainIdentityChecker } from "#workers/modules/reward-plan/beneficiaries.ts";
import { rewardsSettingsFromEnvironment } from "./settings.ts";
import { rewardsSignerFromEnvironment } from "./signer.ts";
import { vaultRewardsJob } from "./job.ts";

const NAME = "vault-rewards";

export async function runVaultRewards(environment: Readonly<Record<string, string | undefined>>, signal: AbortSignal): Promise<void> {
  const config = workerConfigFromEnvironment(environment), settings = rewardsSettingsFromEnvironment(environment);
  const webhookUrl = trustedUrlSetting(environment, "BLAST_WORKER_ALERT_WEBHOOK_URL", config.environment === "production");
  const signer = rewardsSignerFromEnvironment(environment, settings.adminCapId, config.gasBudgetMist);
  const secrets = workerSecrets(environment);
  const provider = boundedProvider(config.timings.providerTimeoutMs);

  await runWorker({ name: NAME, environment, config, secrets, webhookUrl }, signal, ({ log, client, pool, alerts, holder }) => {
    const identities = chainIdentityChecker(new SuiGraphQLClient({ network: "mainnet", url: config.graphql.url }), client, provider);
    const gated = withWorkerReleaseGate({ pool, identity: (fingerprint) => ({ role: NAME, network: "mainnet", fingerprint, signerAddress: signer.address, adminCapId: settings.adminCapId }), access: async (): Promise<WorkerAccess> => {
      const accepted = await evaluateWorkerAccess(config, client);
      if (accepted.status === "blocked") return accepted;
      const standing = await (async () => {
        const role = coreRoleType(coreDeployment(accepted.deployment), "RewardsAdmin");
        return adminCapStanding(client, accepted.deployment, settings.adminCapId, signer.address, role, provider);
      })().catch(() => "unreadable" as const);
      if (standing === "granted") return accepted;
      return { status: "blocked", network: "mainnet", reasons: [standing === "unreadable" ? "rewards-admin-unreadable" : "rewards-admin-cap-roles"] };
    } });
    const jobs = [vaultRewardsJob(settings, identities, alerts)];
    const worker = createWorker({ config, pool, client, signer, jobs, holder, log,
      access: async () => {
        const accepted = await gated();
        if (accepted.status === "blocked") await alerts.raise(`job_stalled:${NAME}`, { state: "blocked", reasons: accepted.reasons.join(",") }, { graceMs: JOB_STALLED_AFTER_MS });
        else await alerts.clear(`job_stalled:${NAME}`);
        return accepted;
      },
      onFundingAlert: funding => { void alerts.raise(`relayer_low:${NAME}`, { address: signer.address, balanceMist: String(funding.balanceMist), thresholdMist: String(funding.thresholdMist) }); },
    });

    return { jobs: jobs.map((job) => job.name), run: (stop) => worker.run(stop) };
  });
}
