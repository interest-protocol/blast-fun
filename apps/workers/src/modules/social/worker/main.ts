// The social worker process (`start.sh social`, social-feed T-025):
// the watcher login's pool on the primary, the lease-holding runtime, the
// intent steps (T-024, T-026), the claim steps (R3-63), the milestone steps
// (T-027, T-029), the notification steps (UI-13) and the daily portfolio
// snapshot (OA-25 Q16). It exits 0 before connecting when the social feed is
// off. Output is one redacted JSON line per metric or log.

import { randomUUID } from "node:crypto";

import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-deployments-sdk";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { isSocialWorkerEnabled } from "@blast/core/lib/social-flag.ts";
import { createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { watcherPooledUrl } from "@blast/core/modules/database/topology.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { mainnetClient } from "#workers/modules/worker-runtime/client.ts";
import { redactingLog, workerSecrets, type WorkerLog } from "#workers/modules/worker-runtime/log.ts";
import { mainnetNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { parseReferralAccountingProfile, referralRevenueStep } from "#workers/modules/social/referrals/collect.ts";
import { claimSteps } from "#workers/modules/social/claims/settle.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { intentSteps } from "#workers/modules/social/intents/resolve.ts";
import { milestoneSteps } from "#workers/modules/social/milestones/generate.ts";
import { notificationSteps } from "#workers/modules/social/notifications/generate.ts";
import type { PortfolioFullnode } from "#workers/modules/social/portfolio/balances.ts";
import { registerWalletsStep } from "#workers/modules/social/portfolio/register-wallets.ts";
import { portfolioSnapshotSteps } from "#workers/modules/social/portfolio/snapshots.ts";
import { createSocialAlerts } from "./alerts.ts";
import { socialWorkerConfigFromEnvironment } from "./config.ts";
import { createSocialWorker, type SocialWorker } from "./runtime.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type SocialWorkerOverrides = Readonly<{ log?: WorkerLog; now?: () => number; fetcher?: typeof fetch; fullnode?: PortfolioFullnode }>;

/** The app's mainnet client (`mainnetNodeUrl`), used only for bounded current portfolio balances. */
function mainnetFullnode(baseUrl: string) {
  return processSingleton("social.worker-fullnode", () => mainnetClient(baseUrl).core);
}

/** The secrets a social worker line must never carry: the database URLs, the alert webhooks and the node URL. */
export function socialWorkerSecrets(environment: Environment): string[] {
  const secrets = workerSecrets(environment);
  for (const name of ["SOCIAL_ALERT_WEBHOOK_URL", "PRESALE_ALERT_WEBHOOK_URL", "PRESALE_SUI_GRPC_URL"]) {
    const value = environment[name]?.trim();
    if (value) secrets.push(value);
  }
  return secrets;
}

/** Builds the worker from `environment` (configuration errors name variables only). */
export function openSocialWorker(
  environment: Environment,
  overrides: SocialWorkerOverrides = {},
): Readonly<{ worker: SocialWorker; log: WorkerLog; close(): Promise<void> }> {
  const secrets = socialWorkerSecrets(environment);
  const log = overrides.log ?? redactingLog(secrets, undefined, environment);
  const config = socialWorkerConfigFromEnvironment(environment);
  const nodeUrl = mainnetNodeUrl(environment);
  if (!nodeUrl) throw new Error("PRESALE_SUI_GRPC_URL must be an https URL.");
  const referralProfile = environment.SOCIAL_REFERRAL_PROFILE
    ? parseReferralAccountingProfile(
        JSON.parse(environment.SOCIAL_REFERRAL_PROFILE),
      )
    : null;
  if (
    referralProfile &&
    (referralProfile.network !== config.selection?.network ||
      referralProfile.deployment_fingerprint !== config.selection?.deployment)
  ) {
    throw new Error(
      "SOCIAL_REFERRAL_PROFILE must match the selected deployment.",
    );
  }
  if (referralProfile && environment.NODE_ENV === "production") {
    const deployment = BLAST_DEPLOYMENTS.mainnet;
    if (!deployment || deploymentFingerprint(deployment) !== referralProfile.deployment_fingerprint ||
      deployment.packages.core.originalPackageId !== referralProfile.core_original_package ||
      deployment.packages.presale.originalPackageId !== referralProfile.presale_original_package ||
      (referralProfile.launchpad_original_package !== null &&
        deployment.packages.launchpad.originalPackageId !== referralProfile.launchpad_original_package)) {
      throw new Error("SOCIAL_REFERRAL_PROFILE must use the published contract packages.");
    }
  }
  const pool = createRuntimePool(watcherPooledUrl(environment), config.pool, "social");
  const socialConfig = createSocialConfigReader(autocommitReader(pool, "social", { label: "social.config" }));
  const now = overrides.now ?? Date.now;
  const participantMilestones = async () => (await socialConfig.getSocialConfig()).participant_milestones;
  const holderMilestones = async () => (await socialConfig.getSocialConfig()).holder_milestones;
  const worker = createSocialWorker({
    pool,
    steps: [
      registerWalletsStep,
      ...(referralProfile ? [referralRevenueStep(referralProfile)] : []),
      // Intents first: an attribution raises the post's "through" counts and a
      // why joins the new item, both of which the notification steps then read.
      ...intentSteps({ batchSize: config.batchSize }),
      // Claims a browser left open: cut-bound exact shared native evidence.
      ...claimSteps({ batchSize: config.batchSize }),
      ...milestoneSteps({ batchSize: config.batchSize, participantMilestones, holderMilestones }),
      ...notificationSteps({
        batchSize: config.batchSize,
        retentionDays: config.retentionDays,
        unlockLeadDays: config.unlockLeadDays,
        participantMilestones,
      }),
      // Last: once a UTC day it values every account (OA-25 Q16); nothing else reads it.
      ...portfolioSnapshotSteps({
        batchSize: config.portfolioSnapshotBatch,
        retentionDays: config.portfolioSnapshotRetentionDays,
        fullnode: () => overrides.fullnode ?? mainnetFullnode(nodeUrl),
      }),
    ],
    config,
    selection: config.selection,
    holder: randomUUID(),
    log,
    now,
    alerts: createSocialAlerts({ webhookUrl: config.alertWebhookUrl, log, secrets, now, fetcher: overrides.fetcher }),
  });
  return Object.freeze({ worker, log, close: () => pool.end() });
}

/**
 * Runs until `signal` aborts, then releases the lease and the pool. Returns
 * `"disabled"` at once, without connecting, unless `BLAST_SOCIAL_ENABLED` is
 * exactly `true` or `team`: the worker serves no pages, so the team-only test
 * (`team`) runs it as at launch (`launch-flags.ts`).
 */
export async function runSocialWorker(
  environment: Environment,
  signal: AbortSignal,
  overrides: SocialWorkerOverrides = {},
): Promise<"disabled" | "stopped"> {
  if (!isSocialWorkerEnabled(environment)) return "disabled";
  const { worker, log, close } = openSocialWorker(environment, overrides);
  try {
    log("social.worker.started", { holder: worker.holder, steps: worker.steps.join(",") });
    await worker.run(signal);
    log("social.worker.stopped", { holder: worker.holder });
    return "stopped";
  } finally {
    await close();
  }
}
