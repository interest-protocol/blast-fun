import { wholeNumberSetting } from "#workers/lib/validation.ts";

import {
  watcherPoolSettingsFromEnvironment,
  type PoolSettings,
} from "@blast/core/modules/database/pool.ts";

import { trustedUrlSetting } from "#workers/modules/worker-runtime/config.ts";

import {
  expectedDeployment,
  type ExpectedDeployment,
} from "@blast/core/modules/launchpad-contract/provenance.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The social worker's settings (`start.sh social`), all optional with
 * safe defaults except the watcher login's URL, which the process opens its
 * pool from (`WATCHER_DATABASE_URL`, read by `main.ts`, never kept here).
 * Errors name variables, never values. Chain steps require the existing
 * mainnet binding from BLAST_NETWORK and BLAST_DEPLOYMENT_FINGERPRINT;
 * the database identity is verified against that explicit selection.
 */
export type SocialWorkerConfig = Readonly<{
  /** `SOCIAL_WORKER_INTERVAL_MS`: one pass every 5 s by default (1 s to 60 s). */
  intervalMs: number;
  /** Failed passes back off, doubling from the interval to this (60 s). */
  maxBackoffMs: number;
  /** `SOCIAL_WORKER_LEASE_TTL_MS`: 30 s by default (5 s to 50 s), so a standby takes over within 60 s. */
  leaseTtlMs: number;
  /** `SOCIAL_NOTIFICATION_BATCH`: commits read per pass (500 by default, 10 to 5,000). */
  batchSize: number;
  /** `SOCIAL_NOTIFICATION_RETENTION_DAYS`: notifications older than this are deleted (90 by default, 7 to 730). */
  retentionDays: number;
  /** `SOCIAL_NOTIFICATION_UNLOCK_LEAD_DAYS`: how long before a team unlock backers hear of it (7 by default, 1 to 120). */
  unlockLeadDays: number;
  /**
   * `SOCIAL_PORTFOLIO_SNAPSHOT_BATCH`: accounts the daily portfolio snapshot values per pass (100 by default, 10 to
   * 1,000). Each costs two fullnode reads per wallet, so a pass's fullnode calls stay in the low hundreds.
   */
  portfolioSnapshotBatch: number;
  /** `SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS`: an account's snapshots older than this are deleted (400 by default, 31 to 3,650). */
  portfolioSnapshotRetentionDays: number;
  /** `SOCIAL_ALERT_WEBHOOK_URL`, else `PRESALE_ALERT_WEBHOOK_URL`, else none (alerts are log lines). Secret. */
  alertWebhookUrl: string | null;
  pool: PoolSettings;
  /** Explicit indexed deployment binding; missing selection blocks chain steps. */
  selection: ExpectedDeployment | null;
}>;

function webhook(environment: Environment): string | null {
  const name = ["SOCIAL_ALERT_WEBHOOK_URL", "PRESALE_ALERT_WEBHOOK_URL"].find((key) => environment[key]?.trim());
  return name ? trustedUrlSetting(environment, name, environment.BLAST_WORKER_ENVIRONMENT === "production") : null;
}

export function socialWorkerConfigFromEnvironment(
  environment: Environment = process.env,
): SocialWorkerConfig {
  const intervalMs = wholeNumberSetting(environment, "SOCIAL_WORKER_INTERVAL_MS", 5_000, 1_000, 60_000);
  return Object.freeze({
    intervalMs,
    maxBackoffMs: Math.max(intervalMs, 60_000),
    leaseTtlMs: wholeNumberSetting(environment, "SOCIAL_WORKER_LEASE_TTL_MS", 30_000, 5_000, 50_000),
    batchSize: wholeNumberSetting(environment, "SOCIAL_NOTIFICATION_BATCH", 500, 10, 5_000),
    retentionDays: wholeNumberSetting(environment, "SOCIAL_NOTIFICATION_RETENTION_DAYS", 90, 7, 730),
    unlockLeadDays: wholeNumberSetting(environment, "SOCIAL_NOTIFICATION_UNLOCK_LEAD_DAYS", 7, 1, 120),
    portfolioSnapshotBatch: wholeNumberSetting(environment, "SOCIAL_PORTFOLIO_SNAPSHOT_BATCH", 100, 10, 1_000),
    portfolioSnapshotRetentionDays: wholeNumberSetting(
      environment,
      "SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS",
      400,
      31,
      3_650,
    ),
    alertWebhookUrl: webhook(environment),
    pool: watcherPoolSettingsFromEnvironment(environment),
    selection: expectedDeployment(environment),
  });
}
