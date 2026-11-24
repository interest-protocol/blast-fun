import { boundedInteger } from "@blast/core/lib/config/bounded-integer.ts";

/** Server-side limits applied with SET LOCAL at the start of every transaction. */
export interface TransactionTimeouts {
  readonly idleInTransactionMs: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface PoolSettings extends TransactionTimeouts {
  readonly connectionTimeoutMs: number;
  readonly queryTimeoutMs?: number;
  readonly idleTimeoutMs: number;
  readonly max: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Per-instance limits. With Fluid compute one instance serves many requests,
 * so `max` bounds this instance's share of the pooler's client connections:
 * instances × max must stay below its 10,000. Behind PgBouncer's transaction
 * mode a client connection only holds a PostgreSQL backend while a statement
 * or transaction runs, so the pool size (10) is set by how many requests an
 * instance runs at once, not by the compute's backend count.
 */
export function poolSettingsFromEnvironment(
  environment: Environment = process.env,
): PoolSettings {
  return Object.freeze({
    connectionTimeoutMs: boundedInteger(environment, "DATABASE_CONNECT_TIMEOUT_MS", 5_000, 250, 30_000),
    idleInTransactionMs: boundedInteger(environment, "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", 15_000, 1_000, 120_000),
    idleTimeoutMs: boundedInteger(environment, "DATABASE_POOL_IDLE_TIMEOUT_MS", 10_000, 1_000, 120_000),
    lockTimeoutMs: boundedInteger(environment, "DATABASE_LOCK_TIMEOUT_MS", 3_000, 100, 60_000),
    max: boundedInteger(environment, "DATABASE_POOL_MAX", 10, 1, 50),
    statementTimeoutMs: boundedInteger(environment, "DATABASE_STATEMENT_TIMEOUT_MS", 8_000, 500, 120_000),
  });
}

/**
 * The replica pool's limits: the primary's timeouts, with its own size
 * (`DATABASE_REPLICA_POOL_MAX`) because chain joins and sensitive work scale
 * independently.
 */
export function replicaPoolSettingsFromEnvironment(
  environment: Environment = process.env,
): PoolSettings {
  return Object.freeze({
    ...poolSettingsFromEnvironment({ ...environment, DATABASE_POOL_MAX: undefined }),
    max: boundedInteger(environment, "DATABASE_REPLICA_POOL_MAX", 10, 1, 50),
  });
}

/**
 * The operational worker's pool on the primary (`WATCHER_DATABASE_URL`): the
 * web runtime's timeouts, at most 2 connections (`WATCHER_DATABASE_POOL_MAX`,
 * 1–2). The web pool's size never applies.
 */
export function watcherPoolSettingsFromEnvironment(
  environment: Environment = process.env,
): PoolSettings {
  return Object.freeze({
    ...poolSettingsFromEnvironment({ ...environment, DATABASE_POOL_MAX: undefined }),
    max: boundedInteger(environment, "WATCHER_DATABASE_POOL_MAX", 2, 1, 2),
  });
}

/** Fresh partner verification has a separate pool with short timeouts. */
export const PARTNER_VERIFIER_POOL_SETTINGS: PoolSettings = Object.freeze({
  max: 2,
  connectionTimeoutMs: 1_000,
  queryTimeoutMs: 750,
  idleTimeoutMs: 10_000,
  idleInTransactionMs: 1_000,
  lockTimeoutMs: 500,
  statementTimeoutMs: 500,
});
