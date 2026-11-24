import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RECORDS_PER_TRANSACTION, workerConfigFromEnvironment } from "./config.ts";
import { gasBudgetFor, MAX_GAS_BUDGET_MIST, MAX_RECORDS_PER_TRANSACTION } from "./signer.ts";
const TIMINGS = {
  BLAST_WORKER_POLL_INTERVAL_MS: "1000",
  BLAST_WORKER_LEASE_TTL_MS: "30001",
  BLAST_WORKER_PROVIDER_TIMEOUT_MS: "4000",
  BLAST_WORKER_CONFIRM_TIMEOUT_MS: "10000",
  BLAST_WORKER_RETRY_BASE_MS: "500",
  BLAST_WORKER_RETRY_MAX_MS: "60000",
  BLAST_WORKER_MAX_ATTEMPTS: "5",
  BLAST_WORKER_BATCH_SIZE: "50",
  BLAST_WORKER_GAS_BUDGET_MIST: "50000000",
  BLAST_WORKER_FUNDING_ALERT_MIST: "1000000000",
};

const LOCAL = {
  ...TIMINGS,
  WATCHER_DATABASE_URL: "postgres://watch:watch-secret@127.0.0.1:5433/blast",
  BLAST_WORKER_ENVIRONMENT: "non-production",
  BLAST_WORKER_SUI_GRPC_URL: "http://127.0.0.1:3199",
  BLAST_WORKER_DEPLOYMENT_MANIFEST: "/tmp/manifest.json",
  BLAST_NETWORK: "mainnet",
  BLAST_DEPLOYMENT_FINGERPRINT: "a".repeat(64),
};

function refusal(read: () => unknown, expected: RegExp): void {
  assert.throws(read, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /watch-secret|suiprivkey|grpc-secret/);
    return true;
  });
}

test("worker timings, limits and thresholds are configuration, never defaults", () => {
  const config = workerConfigFromEnvironment(LOCAL);
  assert.equal(config.environment, "non-production");
  assert.deepEqual(config.node, { kind: "grpc", url: "http://127.0.0.1:3199" });
  assert.deepEqual(config.graphql, { url: "https://graphql.mainnet.sui.io/graphql" });
  assert.deepEqual(config.selection, { network: "mainnet", deployment: "a".repeat(64) });
  assert.equal(config.manifestFile, "/tmp/manifest.json");
  assert.equal(config.pool.max, 2);
  assert.deepEqual(config.timings, {
    pollIntervalMs: 1_000,
    leaseTtlMs: 30_001,
    providerTimeoutMs: 4_000,
    confirmTimeoutMs: 10_000,
    retryBaseMs: 500,
    retryMaxMs: 60_000,
  });
  assert.equal(config.maxAttempts, 5);
  assert.equal(config.batchSize, 50);
  assert.equal(config.gasBudgetMist, 50_000_000n);
  assert.equal(config.fundingAlertMist, 1_000_000_000n);

  for (const name of Object.keys(TIMINGS)) {
    refusal(() => workerConfigFromEnvironment({ ...LOCAL, [name]: undefined }), new RegExp(`${name} is required`));
    refusal(() => workerConfigFromEnvironment({ ...LOCAL, [name]: "-1" }), new RegExp(name));
    refusal(() => workerConfigFromEnvironment({ ...LOCAL, [name]: "1.5" }), new RegExp(name));
  }
});

test("records per transaction default to 8 and are 1 to the signer's limit", () => {
  assert.equal(workerConfigFromEnvironment(LOCAL).recordsPerTransaction, DEFAULT_RECORDS_PER_TRANSACTION);
  assert.equal(DEFAULT_RECORDS_PER_TRANSACTION, 8);
  assert.equal(workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_RECORDS_PER_TRANSACTION: "1" }).recordsPerTransaction, 1);
  assert.equal(
    workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_RECORDS_PER_TRANSACTION: String(MAX_RECORDS_PER_TRANSACTION) }).recordsPerTransaction,
    MAX_RECORDS_PER_TRANSACTION,
  );
  for (const value of ["0", "-1", "1.5", "many", String(MAX_RECORDS_PER_TRANSACTION + 1)]) {
    refusal(() => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_RECORDS_PER_TRANSACTION: value }), /BLAST_WORKER_RECORDS_PER_TRANSACTION/);
  }
});

test("a transaction's gas budget is the per-record budget times its records, at most Sui's maximum", () => {
  assert.equal(gasBudgetFor(50_000_000n, 1), 50_000_000n);
  assert.equal(gasBudgetFor(50_000_000n, 8), 400_000_000n);
  assert.equal(gasBudgetFor(MAX_GAS_BUDGET_MIST, 2), MAX_GAS_BUDGET_MIST);
});

test("thresholds must keep their order: the funding alert fires while gas can still pay, and a lease outlives an attempt", () => {
  refusal(
    () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_FUNDING_ALERT_MIST: "50000000" }),
    /BLAST_WORKER_FUNDING_ALERT_MIST must exceed BLAST_WORKER_GAS_BUDGET_MIST/,
  );
  refusal(
    () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_RETRY_MAX_MS: "100" }),
    /BLAST_WORKER_RETRY_MAX_MS must be at least BLAST_WORKER_RETRY_BASE_MS/,
  );
  // After the last renewal: execute (P), wait (C + P), reconcile (P), attribution (P), plus one P of margin.
  // C = 10 s and P = 4 s: a 20 s lease (accepted before R-001, and seen to lapse) is refused, and so is exactly C + 5P.
  for (const ttl of ["18000", "20000", "26000", "30000"]) {
    refusal(
      () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_LEASE_TTL_MS: ttl }),
      /BLAST_WORKER_LEASE_TTL_MS must exceed BLAST_WORKER_CONFIRM_TIMEOUT_MS plus five times BLAST_WORKER_PROVIDER_TIMEOUT_MS/,
    );
  }
  assert.equal(workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_LEASE_TTL_MS: "30001" }).timings.leaseTtlMs, 30_001);
  // The active process keeps its signer lease across the poll interval and the next deployment check.
  refusal(
    () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_POLL_INTERVAL_MS: "22001" }),
    /BLAST_WORKER_LEASE_TTL_MS must exceed BLAST_WORKER_POLL_INTERVAL_MS plus twice BLAST_WORKER_PROVIDER_TIMEOUT_MS/,
  );
});

test("the worker reaches its own database login and refuses fixture nodes and manifests in production", () => {
  refusal(() => workerConfigFromEnvironment({ ...LOCAL, WATCHER_DATABASE_URL: undefined }), /WATCHER_DATABASE_URL is required/);
  refusal(() => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_ENVIRONMENT: "staging" }), /BLAST_WORKER_ENVIRONMENT/);
  refusal(
    () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_SUI_GRPC_URL: undefined }),
    /BLAST_WORKER_SUI_GRPC_URL is required/,
  );
  refusal(
    () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_FIXTURE_NODE_ORIGIN: "http://127.0.0.1:3199" }),
    /BLAST_WORKER_FIXTURE_NODE_ORIGIN is unsupported/,
  );
  refusal(
    () => workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_SUI_GRPC_URL: "http://10.0.0.8:3199" }),
    /BLAST_WORKER_SUI_GRPC_URL must be an https URL/,
  );
  const production = {
    ...LOCAL,
    BLAST_WORKER_ENVIRONMENT: "production",
    BLAST_WORKER_DEPLOYMENT_MANIFEST: undefined,
    BLAST_WORKER_SUI_GRPC_URL: "https://fullnode.mainnet.sui.io:443",
    WATCHER_DATABASE_URL: "postgresql://blast_watch:watch-secret@ep-bold-1-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full",
  };
  assert.deepEqual(workerConfigFromEnvironment(production).node, { kind: "grpc", url: "https://fullnode.mainnet.sui.io:443" });
  // Production endpoint rules key on the worker's own selection, not on a backend target.
  refusal(
    () => workerConfigFromEnvironment({ ...production, WATCHER_DATABASE_URL: LOCAL.WATCHER_DATABASE_URL }),
    /WATCHER_DATABASE_URL must be a Neon endpoint in production/,
  );
  refusal(
    () => workerConfigFromEnvironment({ ...production, BLAST_WORKER_FIXTURE_NODE_ORIGIN: "http://127.0.0.1:3199" }),
    /BLAST_WORKER_FIXTURE_NODE_ORIGIN is unsupported/,
  );
  refusal(
    () => workerConfigFromEnvironment({ ...production, BLAST_WORKER_DEPLOYMENT_MANIFEST: "/tmp/manifest.json" }),
    /BLAST_WORKER_DEPLOYMENT_MANIFEST is refused in production/,
  );
  refusal(
    () => workerConfigFromEnvironment({ ...production, BLAST_WORKER_SUI_GRPC_URL: "http://fullnode.test" }),
    /BLAST_WORKER_SUI_GRPC_URL must be an https URL/,
  );
});

test("an unselected deployment is not a startup error: the worker starts and records a configuration block", () => {
  const config = workerConfigFromEnvironment({ ...LOCAL, BLAST_NETWORK: undefined, BLAST_DEPLOYMENT_FINGERPRINT: undefined });
  assert.equal(config.selection, null);
});

test("the Sui gRPC URL takes every loopback host outside production and keeps its text", () => {
  for (const url of ["http://127.5.6.7:3199", "http://[::1]:3199", "http://localhost:3199/"]) {
    assert.deepEqual(workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_SUI_GRPC_URL: ` ${url} ` }).node, { kind: "grpc", url });
  }
  assert.deepEqual(
    workerConfigFromEnvironment({ ...LOCAL, BLAST_WORKER_SUI_GRPC_URL: "https://provider:key@grpc.test/v1" }).node,
    { kind: "grpc", url: "https://provider:key@grpc.test/v1" },
  );
});
