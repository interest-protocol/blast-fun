import { poolSettingsFromEnvironment, replicaPoolSettingsFromEnvironment, PARTNER_VERIFIER_POOL_SETTINGS, type PoolSettings, type TransactionTimeouts } from "./pool-settings.ts";
export { poolSettingsFromEnvironment, replicaPoolSettingsFromEnvironment, watcherPoolSettingsFromEnvironment, PARTNER_VERIFIER_POOL_SETTINGS, type PoolSettings, type TransactionTimeouts } from "./pool-settings.ts";

import { attachDatabasePool } from "@vercel/functions";
import { Pool, type PoolConfig } from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { processSingleton, takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";
import { databaseConnectionUrl, primaryPooledUrl, replicaPooledUrl, partnerVerifierPooledUrl } from "./topology.ts";

export function createPool(
  databaseUrl = primaryPooledUrl(),
  overrides: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  return new Pool({
    connectionString: databaseConnectionUrl(databaseUrl),
    max: 10,
    ...overrides,
  });
}

// Process-wide, like the pool: the copy of this module that created a pool
// may not be the copy a caller asks about it.
const transactionTimeouts = processSingleton(
  "mission-control.database.transaction-timeouts",
  () => new WeakMap<Pool, TransactionTimeouts>(),
);

export function transactionTimeoutsFor(pool: Pool): TransactionTimeouts | undefined {
  return transactionTimeouts.get(pool);
}

const SLOW_ACQUIRE_MS = 100;
const SLOW_ACQUIRE_SAMPLE_RATE = 0.05;
const SUMMARY_INTERVAL_MS = 60_000;

interface AcquireStats {
  applicationName: string;
  acquisitions: number;
  failures: number;
  lastSummaryAt: number;
  maxWaitMs: number;
  slow: number;
  totalWaitMs: number;
}

const acquireStats = processSingleton(
  "mission-control.database.acquire-stats",
  () => new WeakMap<Pool, AcquireStats>(),
);

/** Records how long a request waited for a connection from `pool`. */
export function observeAcquire(pool: Pool, waitMs: number, error?: unknown): void {
  const stats = acquireStats.get(pool);
  if (!stats) return;
  if (error) {
    stats.failures += 1;
    recordMetric("db.acquire", {
      pool: stats.applicationName,
      error: errorLabel(error),
      outcome: "error",
      total: pool.totalCount,
      waitMs: Math.round(waitMs),
      waiting: pool.waitingCount,
    });
  } else {
    stats.acquisitions += 1;
    stats.totalWaitMs += waitMs;
    stats.maxWaitMs = Math.max(stats.maxWaitMs, waitMs);
    if (waitMs >= SLOW_ACQUIRE_MS) {
      stats.slow += 1;
      // Under saturation every request is slow; the minute summary counts
      // them all, so log a sample of individual waits.
      if (Math.random() < SLOW_ACQUIRE_SAMPLE_RATE) recordMetric("db.acquire", {
        pool: stats.applicationName,
        outcome: "slow",
        total: pool.totalCount,
        waitMs: Math.round(waitMs),
        waiting: pool.waitingCount,
      });
    }
  }
  const now = Date.now();
  if (now - stats.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    recordMetric("db.pool", {
      pool: stats.applicationName,
      acquisitions: stats.acquisitions,
      failures: stats.failures,
      idle: pool.idleCount,
      maxWaitMs: Math.round(stats.maxWaitMs),
      meanWaitMs: stats.acquisitions
        ? Math.round((stats.totalWaitMs / stats.acquisitions) * 10) / 10
        : 0,
      slow: stats.slow,
      total: pool.totalCount,
      waiting: pool.waitingCount,
    });
    Object.assign(stats, {
      acquisitions: 0,
      failures: 0,
      lastSummaryAt: now,
      maxWaitMs: 0,
      slow: 0,
      totalWaitMs: 0,
    });
  }
}

/**
 * A pool that applies the runtime timeouts and reports acquisition metrics.
 * Route handlers use `primaryPool()` instead; scripts and tests that
 * need the same behaviour against another database call this directly.
 */
export function createRuntimePool(
  databaseUrl: string,
  settings: PoolSettings,
  applicationName = "mission-control",
): Pool {
  const pool = createPool(databaseUrl, {
    application_name: applicationName,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    max: settings.max,
    // statement_timeout starts only when PostgreSQL runs a statement. When
    // Neon's pooler has no free server connection it queues the query first,
    // so a client-side limit keeps a queued request from hanging for minutes.
    query_timeout: settings.queryTimeoutMs ?? settings.statementTimeoutMs + 2_000,
  });
  transactionTimeouts.set(pool, {
    idleInTransactionMs: settings.idleInTransactionMs,
    lockTimeoutMs: settings.lockTimeoutMs,
    statementTimeoutMs: settings.statementTimeoutMs,
  });
  acquireStats.set(pool, {
    applicationName,
    acquisitions: 0,
    failures: 0,
    lastSummaryAt: Date.now(),
    maxWaitMs: 0,
    slow: 0,
    totalWaitMs: 0,
  });
  // An idle client can lose its socket (Neon scale-to-zero, network resets).
  // pg emits that on the pool; without a listener it would crash the instance.
  pool.on("error", (error) => {
    recordMetric("db.idle_client_error", { pool: applicationName, error: errorLabel(error) });
  });
  return pool;
}

/**
 * The one pool per function instance. Fluid compute reuses instances across
 * requests, so routes share this pool instead of opening and closing their own.
 * It is one per process, not per module copy: route handlers and page
 * rendering load this module separately, and each copy keeping its own pool
 * doubled an instance's connections (two `db.pool` summaries per process in
 * the browse run).
 * `attachDatabasePool` keeps a suspending instance alive until idle clients
 * have closed, so connections are not leaked when Vercel freezes it. The cost:
 * each invocation stays open (not billed as active CPU) for up to
 * idleTimeoutMs after its last release. It tracks one pool per process.
 */
export function primaryPool(): Pool {
  return processSingleton("mission-control.database.pool", () => {
    const pool = createRuntimePool(primaryPooledUrl(), poolSettingsFromEnvironment());
    attachDatabasePool(pool);
    return pool;
  });
}

/**
 * The one read-replica pool per process, for chain joins. It fails closed
 * without `DATABASE_REPLICA_URL`; callers reach it through `databaseFor` and degrade
 * through the read router (`modules/read-routing`), never by borrowing the
 * primary here.
 * `attachDatabasePool` keeps one idle timer for the process, so both pools
 * are waited for after the last release of either.
 */
export function replicaPool(): Pool {
  return processSingleton("database.replica-pool", () => {
    const pool = createRuntimePool(
      replicaPooledUrl(),
      replicaPoolSettingsFromEnvironment(),
      "blast-replica",
    );
    attachDatabasePool(pool);
    return pool;
  });
}

const PARTNER_VERIFIER_POOL = "database.partner-verifier-pool";

/** Exactly two connections for fresh partner authority on the primary. */
export function partnerVerifierPool(): Pool {
  return processSingleton(PARTNER_VERIFIER_POOL, () => {
    const pool = createRuntimePool(partnerVerifierPooledUrl(), PARTNER_VERIFIER_POOL_SETTINGS, "blast-partner-verifier");
    attachDatabasePool(pool);
    return pool;
  });
}

/** Close only an already-created verifier pool; shutdown never opens a connection. */
export async function endPartnerVerifierPool(): Promise<void> {
  await takeProcessSingleton<Pool>(PARTNER_VERIFIER_POOL)?.end();
}
