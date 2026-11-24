// The vault-buyback process owns a separate key, cap, signer lease and gate.

import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import { runWorker } from "#workers/modules/worker-runtime/bootstrap.ts";
import { workerSecrets } from "#workers/modules/worker-runtime/log.ts";
import { trustedUrlSetting, workerConfigFromEnvironment } from "#workers/modules/worker-runtime/config.ts";
import { createWorker } from "#workers/modules/worker-runtime/runtime.ts";
import { buybackAccessCheck, type BuybackAccess } from "./access.ts";
import { buybackJob } from "./job.ts";
import { secureUnit } from "./schedule.ts";
import { buybackSettingsFromEnvironment } from "./settings.ts";
import { loadBuybackSigner, type BuybackSigner } from "./signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export const BUYBACK_ALERT_VARIABLE = "BLAST_BUYBACK_ALERT_WEBHOOK_URL";
const ROLE = "vault-buyback";

/** Runs the buyback operator until `signal` aborts, then releases its pool. */
export async function runBuybackWorker(environment: Environment, signal: AbortSignal): Promise<void> {
  // Everything is validated before anything connects: a bad value exits 1 naming its variable.
  const settings = buybackSettingsFromEnvironment(environment);
  const config = workerConfigFromEnvironment(environment);
  const webhookUrl = trustedUrlSetting(environment, BUYBACK_ALERT_VARIABLE, config.environment === "production");
  const market = defaultMarketDataDependencies(environment);
  const signer = loadBuybackSigner(environment, { gasBudgetMist: config.gasBudgetMist, adminCapId: settings.adminCapId });
  const input = { name: ROLE, environment, config, secrets: workerSecrets(environment), webhookUrl };

  await runWorker(input, signal, ({ log, client, pool, alerts, holder }) => {
    const jobs = [buybackJob({ settings, market, alerts })];
    const worker = createWorker<BuybackAccess, BuybackSigner>({
      config,
      pool,
      client,
      signer,
      jobs,
      holder,
      log,
      random: () => secureUnit(),
      access: buybackAccessCheck({ config, client, pool, log, signerAddress: signer.address, adminCapId: settings.adminCapId }),
      onFundingAlert: (funding) => {
        void alerts.raise(`relayer_low:${ROLE}`, {
          address: signer.address,
          balanceMist: String(funding.balanceMist),
          thresholdMist: String(funding.thresholdMist),
        });
      },
    });

    return { jobs: jobs.map((job) => job.name), run: (stop) => worker.run(stop) };
  });
}
