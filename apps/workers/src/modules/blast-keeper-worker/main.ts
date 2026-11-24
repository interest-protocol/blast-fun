// The blast-keeper process: one worker that runs every keeper job.

import { feeClaimJob } from "../fee-claims/job.ts";
import { gasPoolJob, gasPoolSettings } from "../blast-keeper/gas-pool.ts";
import { keeperActionJob } from "../blast-keeper/jobs.ts";
import { keeperConfigFromEnvironment, keeperMarket } from "../blast-keeper/keepers.ts";
import { loadKeeperSigner } from "../blast-keeper/signer.ts";
import { registrationJob } from "../coin-registration/job.ts";
import { migrationJob } from "../launch-migration/job.ts";
import { openingRoundJob } from "../opening-round/job.ts";
import { runWorker } from "../worker-runtime/bootstrap.ts";
import { workerConfigFromEnvironment } from "../worker-runtime/config.ts";
import { evaluateWorkerAccess } from "../worker-runtime/deployment.ts";
import { workerSecrets } from "../worker-runtime/log.ts";
import { withWorkerReleaseGate } from "../worker-runtime/release-gate.ts";
import { createWorker } from "../worker-runtime/runtime.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** Runs both products permissionless keeper jobs until aborted. */
export async function runBlastKeeper(environment: Environment, signal: AbortSignal): Promise<void> {
  const config = workerConfigFromEnvironment(environment);
  const keepers = keeperConfigFromEnvironment(environment, config.environment, config.timings.providerTimeoutMs);
  const signer = loadKeeperSigner(environment, { gasBudgetMist: config.gasBudgetMist, creationFeeCapMist: keepers.bluefinCreationFeeCapMist });
  const gasPool = gasPoolSettings(environment, config.environment === "production");
  const input = {
    name: "blast-keeper",
    environment,
    config,
    secrets: workerSecrets(environment),
    webhookUrl: keepers.alertWebhookUrl,
  };

  await runWorker(input, signal, ({ log, client, pool, alerts, holder }) => {
    const market = keeperMarket(keepers.market);
    const jobs = [
      gasPoolJob(gasPool, alerts),
      registrationJob(),
      migrationJob(keepers.bluefinCreationFeeCapMist),
      openingRoundJob({ market, alerts, deliveryBatchSize: keepers.deliveryBatchSize, alertAfterMs: keepers.openingRoundAlertMs }),
      feeClaimJob({ alerts, intervalMs: keepers.feeClaimIntervalMs, gasMultiple: keepers.feeClaimGasMultiple }),
      keeperActionJob("presale", keepers.bluefinCreationFeeCapMist),
      keeperActionJob("presale-partner"),
      keeperActionJob("vault-partner"),
      keeperActionJob("vault-fees"),
    ];
    const access = withWorkerReleaseGate({
      pool,
      identity: (fingerprint) => ({ role: "blast-keeper", network: "mainnet", fingerprint, signerAddress: signer.address }),
      access: () => evaluateWorkerAccess(config, client),
    });
    const worker = createWorker({ config, pool, client, signer, jobs, holder, log, access });

    return { jobs: jobs.map((job) => job.name), run: (stop) => worker.run(stop) };
  });
}
