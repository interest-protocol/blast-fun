// The operational worker's configuration, read once at start. Every
// `BLAST_WORKER_*` timing, limit and threshold is configuration with no
// default: a missing or invalid value stops the worker before it connects to
// anything. `BLAST_WORKER_RECORDS_PER_TRANSACTION` is the one exception: a
// throughput setting with a safe default (8), not a deployment fact; an
// invalid value still stops the worker. The watcher pool keeps the T-033 contract instead:
// `WATCHER_DATABASE_POOL_MAX` defaults to 2, and the web runtime's
// `DATABASE_*_TIMEOUT_MS` defaults apply. Messages name the variable, never
// its value. The deployment selection is the exception: an
// unselected deployment starts the worker, which then records a configuration
// block and never signs.

import type { DeploymentEnvironment } from "@interest-protocol/blast-deployments-sdk";

import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";
import {
  watcherPoolSettingsFromEnvironment,
  type PoolSettings,
} from "@blast/core/modules/database/pool.ts";
import { watcherPooledUrl } from "@blast/core/modules/database/topology.ts";
import {
  expectedDeployment,
  type ExpectedDeployment,
} from "@blast/core/modules/launchpad-contract/provenance.ts";
import { deploymentEnvironmentSchema, positiveMistSchema, wholeNumberSetting } from "#workers/lib/validation.ts";

import { MAX_RECORDS_PER_TRANSACTION } from "./signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type WorkerNode = Readonly<{ kind: "grpc"; url: string }>;

/** Sui GraphQL, read-only: the holder identity checker of the rewards planner and relay. */
export type WorkerGraphql = Readonly<{ url: string }>;

/** Mysten's public mainnet GraphQL service, used when `BLAST_WORKER_SUI_GRAPHQL_URL` is unset. */
export const DEFAULT_SUI_GRAPHQL_URL = "https://graphql.mainnet.sui.io/graphql";

export type WorkerTimings = Readonly<{
  /** Pause between passes. */
  pollIntervalMs: number;
  /** How long a lease row holds a job key. */
  leaseTtlMs: number;
  /** Budget of each single provider call. */
  providerTimeoutMs: number;
  /** How long one submission waits for its effects. */
  confirmTimeoutMs: number;
  /** Backoff after a failed pass on a record: full jitter up to base × 2^(attempts), capped at max. */
  retryBaseMs: number;
  retryMaxMs: number;
}>;

export type WorkerConfig = Readonly<{
  databaseUrl: string;
  pool: PoolSettings;
  environment: DeploymentEnvironment;
  /** `BLAST_NETWORK` and `BLAST_DEPLOYMENT_FINGERPRINT`, or null when unselected. */
  selection: ExpectedDeployment | null;
  /** A non-production manifest file; production uses the SDK's released registry only. */
  manifestFile: string | null;
  node: WorkerNode;
  graphql: WorkerGraphql;
  timings: WorkerTimings;
  /** Submissions and failed simulations per record before the worker stops trying it. */
  maxAttempts: number;
  /** Candidates discovered and records attempted per pass. */
  batchSize: number;
  /**
   * The most records (migrations, fee claims) one transaction carries,
   * 1–`MAX_RECORDS_PER_TRANSACTION`; `DEFAULT_RECORDS_PER_TRANSACTION` unset.
   */
  recordsPerTransaction: number;
  /** The most one record may spend on gas: a transaction of n records gets n times it, at most `MAX_GAS_BUDGET_MIST`. */
  gasBudgetMist: bigint;
  /** Below this balance the funding alert fires; it exceeds the gas budget. */
  fundingAlertMist: bigint;
}>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** A whole-number setting with no default, at least `minimum` and at most `maximum` when given. */
export function requiredInteger(environment: Environment, name: string, minimum: number, maximum?: number): number {
  required(environment, name);
  try {
    return wholeNumberSetting(environment, name, minimum, minimum, maximum ?? Number.MAX_SAFE_INTEGER);
  } catch {
    const range = maximum === undefined ? `of at least ${minimum}` : `from ${minimum} to ${maximum}`;
    throw new Error(`${name} must be an integer ${range}.`);
  }
}

function positiveInteger(environment: Environment, name: string): number {
  return requiredInteger(environment, name, 1);
}

/**
 * A URL setting a worker calls (an alert webhook, blast-infra), returned as written: https, or http
 * on loopback outside production. Errors name the variable, never the value, which may embed a token.
 */
export function trustedUrlSetting(environment: Environment, name: string, production: boolean): string {
  const raw = environment[name]?.trim();
  trustedUrl(name, raw, { shape: "url", http: production ? "never" : "loopback" });
  return raw!;
}

/** Records per transaction when `BLAST_WORKER_RECORDS_PER_TRANSACTION` is unset. */
export const DEFAULT_RECORDS_PER_TRANSACTION = 8;

function mist(environment: Environment, name: string): bigint {
  const raw = required(environment, name);
  const parsed = positiveMistSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${name} must be a positive u64 amount of MIST.`);
  }
  return parsed.data;
}

function environmentMode(environment: Environment): DeploymentEnvironment {
  const value = required(environment, "BLAST_WORKER_ENVIRONMENT");
  const parsed = deploymentEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("BLAST_WORKER_ENVIRONMENT must be production or non-production.");
  }
  return parsed.data;
}

function node(environment: Environment, mode: DeploymentEnvironment): WorkerNode {
  const grpc = environment.BLAST_WORKER_SUI_GRPC_URL?.trim();
  const fixture = environment.BLAST_WORKER_FIXTURE_NODE_ORIGIN?.trim();
  if (fixture)
    throw new Error("BLAST_WORKER_FIXTURE_NODE_ORIGIN is unsupported; use a Sui gRPC fullnode.");
  if (!grpc)
    throw new Error(
      "BLAST_WORKER_SUI_GRPC_URL is required: the Sui fullnode the worker reads and submits through.",
    );
  return { kind: "grpc", url: trustedUrlSetting(environment, "BLAST_WORKER_SUI_GRPC_URL", mode === "production") };
}

function graphql(environment: Environment, mode: DeploymentEnvironment): WorkerGraphql {
  const url = trustedUrlSetting(
    { BLAST_WORKER_SUI_GRAPHQL_URL: environment.BLAST_WORKER_SUI_GRAPHQL_URL?.trim() || DEFAULT_SUI_GRAPHQL_URL },
    "BLAST_WORKER_SUI_GRAPHQL_URL",
    mode === "production",
  );
  return { url };
}

export function workerConfigFromEnvironment(
  environment: Environment = process.env,
  database?: Readonly<{ databaseUrl: string; pool?: PoolSettings }>,
): WorkerConfig {
  const mode = environmentMode(environment);
  const manifestFile = environment.BLAST_WORKER_DEPLOYMENT_MANIFEST?.trim() || null;
  if (manifestFile && mode === "production") {
    throw new Error(
      "BLAST_WORKER_DEPLOYMENT_MANIFEST is refused in production: only the SDK's released deployment signs.",
    );
  }
  const timings: WorkerTimings = Object.freeze({
    pollIntervalMs: positiveInteger(environment, "BLAST_WORKER_POLL_INTERVAL_MS"),
    leaseTtlMs: positiveInteger(environment, "BLAST_WORKER_LEASE_TTL_MS"),
    providerTimeoutMs: positiveInteger(environment, "BLAST_WORKER_PROVIDER_TIMEOUT_MS"),
    confirmTimeoutMs: positiveInteger(environment, "BLAST_WORKER_CONFIRM_TIMEOUT_MS"),
    retryBaseMs: positiveInteger(environment, "BLAST_WORKER_RETRY_BASE_MS"),
    retryMaxMs: positiveInteger(environment, "BLAST_WORKER_RETRY_MAX_MS"),
  });
  if (timings.retryMaxMs < timings.retryBaseMs) {
    throw new Error("BLAST_WORKER_RETRY_MAX_MS must be at least BLAST_WORKER_RETRY_BASE_MS.");
  }
  // After its last renewal (just before the bytes are sent) a lease covers,
  // in node calls: the submission (P), the wait for effects (C + P), the
  // reconciliation read (P) and the attribution read (P): C + 4P. The margin
  // is one more P for the database writes that close the attempt and release
  // the lease (each also bounded by its statement timeout and far shorter).
  if (timings.leaseTtlMs <= timings.confirmTimeoutMs + 5 * timings.providerTimeoutMs) {
    throw new Error(
      "BLAST_WORKER_LEASE_TTL_MS must exceed BLAST_WORKER_CONFIRM_TIMEOUT_MS plus five times BLAST_WORKER_PROVIDER_TIMEOUT_MS (4 node calls after the last renewal, plus one as margin).",
    );
  }
  // The signer lease is renewed at the end of each pass and again after the
  // next poll interval and deployment check (P): the margin is one more P.
  if (timings.leaseTtlMs <= timings.pollIntervalMs + 2 * timings.providerTimeoutMs) {
    throw new Error(
      "BLAST_WORKER_LEASE_TTL_MS must exceed BLAST_WORKER_POLL_INTERVAL_MS plus twice BLAST_WORKER_PROVIDER_TIMEOUT_MS, so the active process keeps its signer lease between passes.",
    );
  }
  const gasBudgetMist = mist(environment, "BLAST_WORKER_GAS_BUDGET_MIST");
  const fundingAlertMist = mist(environment, "BLAST_WORKER_FUNDING_ALERT_MIST");
  if (fundingAlertMist <= gasBudgetMist) {
    throw new Error(
      "BLAST_WORKER_FUNDING_ALERT_MIST must exceed BLAST_WORKER_GAS_BUDGET_MIST, so it fires while gas can still pay.",
    );
  }
  return Object.freeze({
    databaseUrl: database?.databaseUrl ?? watcherPooledUrl(environment),
    pool: database?.pool ?? watcherPoolSettingsFromEnvironment(environment),
    environment: mode,
    selection: expectedDeployment(environment),
    manifestFile,
    node: node(environment, mode),
    graphql: graphql(environment, mode),
    timings,
    maxAttempts: positiveInteger(environment, "BLAST_WORKER_MAX_ATTEMPTS"),
    batchSize: positiveInteger(environment, "BLAST_WORKER_BATCH_SIZE"),
    recordsPerTransaction: wholeNumberSetting(
      environment,
      "BLAST_WORKER_RECORDS_PER_TRANSACTION",
      DEFAULT_RECORDS_PER_TRANSACTION,
      1,
      MAX_RECORDS_PER_TRANSACTION,
    ),
    gasBudgetMist,
    fundingAlertMist,
  });
}
