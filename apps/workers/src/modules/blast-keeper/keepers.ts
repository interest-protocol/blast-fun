// Keeper settings and the bounded blast-infra opening-round bidder reader.
// Candidates come from committed indexer views; fresh chain reads decide every action.

import type { BlastDeployment, DeploymentEnvironment } from "@interest-protocol/blast-deployments-sdk";

import { readOpeningBidders, type BiddersPage } from "@blast/core/modules/launchpad-contract/activity.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { requiredInteger, trustedUrlSetting } from "#workers/modules/worker-runtime/config.ts";

import { bluefinCreationFeeCap } from "./bluefin-fee.ts";
import { MAX_DELIVERIES_PER_TRANSACTION, type LaunchpadTargets } from "./signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type KeeperConfig = Readonly<{
  bluefinCreationFeeCapMist: bigint;
  /** Secret: the alert channel (a Discord webhook in production). */
  alertWebhookUrl: string;
  /** blast-infra, for opening-round bidders. */
  market: MarketDataDependencies;
  /** Bidders delivered per transaction, within the gas budget. */
  deliveryBatchSize: number;
  /** How long a round may stay unsettled after it ends before the alert. */
  openingRoundAlertMs: number;
  /** How often each launch's fees are claimed. */
  feeClaimIntervalMs: number;
  /** A claim is sent only when worth at least this many times its simulated gas cost. */
  feeClaimGasMultiple: bigint;
}>;

export function keeperConfigFromEnvironment(
  environment: Environment,
  mode: DeploymentEnvironment,
  providerTimeoutMs: number,
): KeeperConfig {
  const production = mode === "production";
  const alertWebhookUrl = trustedUrlSetting(environment, "BLAST_WORKER_ALERT_WEBHOOK_URL", production);
  trustedUrlSetting(environment, "BLAST_INFRA_ORIGIN", production);
  const market = { ...defaultMarketDataDependencies(environment), timeoutMs: providerTimeoutMs };
  const deliveryBatchSize = requiredInteger(
    environment,
    "BLAST_WORKER_DELIVERY_BATCH_SIZE",
    1,
    MAX_DELIVERIES_PER_TRANSACTION,
  );
  return Object.freeze({
    alertWebhookUrl,
    market,
    bluefinCreationFeeCapMist: bluefinCreationFeeCap(environment),
    deliveryBatchSize,
    openingRoundAlertMs: requiredInteger(environment, "BLAST_WORKER_OPENING_ROUND_ALERT_MS", 1),
    feeClaimIntervalMs: requiredInteger(environment, "BLAST_WORKER_FEE_CLAIM_INTERVAL_MS", 1),
    feeClaimGasMultiple: BigInt(requiredInteger(environment, "BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE", 1)),
  });
}

/** One bidders page; `unavailable` when blast-infra could not answer, `refused` when it refused the request. */
export type BiddersRead = BiddersPage | "unavailable" | "refused";

/** The keepers' blast-infra reads; tests pass their own. */
export type KeeperMarket = Readonly<{
  bidders(launchId: string, cursor: string | null): Promise<BiddersRead>;
}>;

/** blast-infra's largest bidders page. */
export const BIDDERS_PAGE = 100;

export function keeperMarket(dependencies: MarketDataDependencies): KeeperMarket {
  return Object.freeze({
    async bidders(launchId: string, cursor: string | null): Promise<BiddersRead> {
      const read = await readOpeningBidders(launchId, { limit: String(BIDDERS_PAGE), cursor }, dependencies);
      if (read.status === "unavailable") return "unavailable";
      if (read.data.kind === "refused") return "refused";
      // A stale page is still a list of who bid: the chain decides who is undelivered.
      return read.data.value.launchId === launchId ? read.data.value : "unavailable";
    },

  });
}

/** The accepted deployment's launchpad package and the shared objects its keeper calls take. */
export function launchpadTargets(deployment: BlastDeployment): LaunchpadTargets {
  const objects = deployment.sharedObjects.launchpad;
  return {
    packageId: deployment.packages.launchpad.packageId,
    packageVersionId: objects.packageVersion.objectId,
    runtimeConfigId: objects.runtimeConfig.objectId,
  };
}
