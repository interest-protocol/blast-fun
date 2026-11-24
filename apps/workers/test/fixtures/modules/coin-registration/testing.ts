// Test harness for the operational worker and its registration job: a
// disposable clone of the migrated template with the role fixture's
// `chain_read_v1`, the SDK's non-production manifest on disk, a generated
// fixture gas key, and the worker settings every test shares. Test-only.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineBlastDeployment, deploymentFingerprint } from "@interest-protocol/blast-deployments-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Pool } from "pg";

import { NON_PRODUCTION_MANIFEST } from "../../final-stack/non-production-deployment.ts";
import { createPool, createRuntimePool } from "../../../../../../packages/core/src/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase, type TestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";

export const MANIFEST = NON_PRODUCTION_MANIFEST;
export const DEPLOYMENT = defineBlastDeployment(MANIFEST);
export const FINGERPRINT = deploymentFingerprint(DEPLOYMENT);
export const LAUNCHPAD = DEPLOYMENT.packages.launchpad.originalPackageId;
/** The core package whose `SealedTreasuryCap` a publication sends beside the ticket. */
export const CORE = DEPLOYMENT.packages.core.originalPackageId;
/** A launchpad package of another lineage. */
export const FOREIGN_LAUNCHPAD = `0x${"f0".repeat(32)}`;

/** A generated fixture gas key; it never holds real value. */
export const FIXTURE_GAS_KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 61));

/** The worker's environment for `databaseUrl` (any login) and a fixture node origin. */
export function workerEnvironment(
  databaseUrl: string,
  manifestFile: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    WATCHER_DATABASE_URL: urlAs(databaseUrl, "blast_watcher"),
    BLAST_WORKER_ENVIRONMENT: "non-production",
    BLAST_WORKER_DEPLOYMENT_MANIFEST: manifestFile,
    BLAST_WORKER_SUI_GRPC_URL: "http://127.0.0.1:9",
    BLAST_NETWORK: DEPLOYMENT.network,
    BLAST_DEPLOYMENT_FINGERPRINT: FINGERPRINT,
    BLAST_WORKER_SIGNER_KEY: FIXTURE_GAS_KEY.getSecretKey(),
    BLAST_WORKER_POLL_INTERVAL_MS: "100",
    BLAST_WORKER_LEASE_TTL_MS: "8000",
    BLAST_WORKER_PROVIDER_TIMEOUT_MS: "1000",
    BLAST_WORKER_CONFIRM_TIMEOUT_MS: "1500",
    BLAST_WORKER_RETRY_BASE_MS: "1",
    BLAST_WORKER_RETRY_MAX_MS: "2",
    BLAST_WORKER_MAX_ATTEMPTS: "3",
    BLAST_WORKER_BATCH_SIZE: "10",
    // One record per transaction, as each job's own tests assume; the batching tests unset it (the default, 8) or set it.
    BLAST_WORKER_RECORDS_PER_TRANSACTION: "1",
    BLAST_WORKER_GAS_BUDGET_MIST: "50000000",
    BLAST_WORKER_FUNDING_ALERT_MIST: "100000000",
    // The launchpad keepers (LP-18, LP-20): an unreachable blast-infra and webhook unless a test serves one.
    BLAST_WORKER_ALERT_WEBHOOK_URL: "http://127.0.0.1:9/alert-hook",
    BLAST_INFRA_ORIGIN: "http://127.0.0.1:9",
    BLAST_WORKER_DELIVERY_BATCH_SIZE: "10",
    BLAST_WORKER_OPENING_ROUND_ALERT_MS: "600000",
    BLAST_WORKER_FEE_CLAIM_INTERVAL_MS: "86400000",
    BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE: "5",
    MISSION_CONTROL_METRICS: process.env.WORKER_TEST_METRICS ?? "off",
    ...overrides,
  };
}

/** Writes the non-production manifest where the worker reads it. */
export async function manifestFile(manifest: unknown = MANIFEST): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "blast-worker-"));
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  return path;
}

/**
 * A database of the test's own, cloned from the migrated template: blast-infra's
 * roles and `chain_read_v1` over the fixture's chain tables, the web
 * migrations, and an index that serves this deployment at `checkpoint`. The
 * role fixture's own coin already has a pool. `drop()` it after the test's
 * pools end.
 */
export async function freshDatabase(checkpoint = 1_000): Promise<TestDatabase> {
  const database = await freshTestDatabase();
  const admin = adminPool(database.url);
  try {
    await admin.query("UPDATE deployment_identity SET network = $1, deployment_fingerprint = $2", [DEPLOYMENT.network, FINGERPRINT]);
    await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive = $1 WHERE pipeline = 'market'", [checkpoint]);
  } finally {
    await admin.end();
  }
  return database;
}

/** blast-infra registering a coin from its `LaunchTicketCreated` at `checkpoint`. */
export async function indexCoin(admin: Pool, coinType: string, checkpoint: number, poolKey: string | null = null): Promise<void> {
  await admin.query(
    `INSERT INTO coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms)
     VALUES ($1, 9, '0xc0ffee', '0xc0ffee', '{}', $2, $3, 1790000000000)`,
    [coinType, poolKey, checkpoint],
  );
}

export function adminPool(databaseUrl: string): Pool {
  return createPool(databaseUrl, { max: 2 });
}

/** The worker's pool as `blast_watcher`, at most 2 connections, with runtime timeouts. */
export function watcherPool(databaseUrl: string): Pool {
  return createRuntimePool(urlAs(databaseUrl, "blast_watcher"), {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    max: 2,
    statementTimeoutMs: 4_000,
  }, "blast-keeper");
}

export type RegistrationRow = {
  meme_type: string;
  state: string;
  attempts: number;
  error_class: string | null;
  outcome: string | null;
  latest_digest: string | null;
  pending_currency_id: string | null;
  publication_digest: string | null;
  ticket_id: string | null;
  shared_currency_id: string | null;
  created_checkpoint: string;
};

export async function registrations(admin: Pool): Promise<Map<string, RegistrationRow>> {
  const { rows } = await admin.query<RegistrationRow>(
    `SELECT meme_type, state, attempts, error_class, outcome, latest_digest, pending_currency_id,
            publication_digest, ticket_id, shared_currency_id, created_checkpoint
     FROM mission_control_coin_registrations ORDER BY created_checkpoint, meme_type`,
  );
  return new Map(rows.map((row) => [row.meme_type, row]));
}

/** Makes every unfinished record eligible now, as if its backoff had passed. */
export async function elapseBackoff(admin: Pool): Promise<void> {
  await admin.query("UPDATE mission_control_coin_registrations SET next_eligible_at = now() - interval '1 second' WHERE state IN ('pending', 'submitted')");
}
