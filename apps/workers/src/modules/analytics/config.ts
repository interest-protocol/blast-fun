import { createHash } from "node:crypto";
import { Pool } from "pg";

type Environment = Readonly<Record<string, string | undefined>>;

export const ANALYTICS_EXPORT_VERSION = "current-lineage-receipts-v1";

export type AnalyticsConfig = Readonly<{
  sourceUrl: string;
  warehouseUrl: string;
  network: string;
  fingerprint: string;
  firstCheckpoint: bigint;
  walletKey: string;
  accountReporting?: Readonly<{ scope: string }>;
}>;

export function readAnalyticsConfig(env: Environment): AnalyticsConfig | null {
  if (env.ANALYTICS_ENABLED !== "true") {
    return null;
  }
  const first = requireValue(env, "ANALYTICS_FIRST_CHECKPOINT");
  if (
    !/^(0|[1-9][0-9]*)$/.test(first) ||
    BigInt(first) > 9223372036854775807n
  ) {
    throw new Error("Invalid ANALYTICS_FIRST_CHECKPOINT");
  }
  const walletKey = requireValue(env, "ANALYTICS_WALLET_HASH_KEY");
  if (walletKey.length < 32) {
    throw new Error("Analytics wallet key must have at least 32 characters");
  }
  const fingerprint = requireValue(env, "ANALYTICS_DEPLOYMENT_FINGERPRINT");
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("Invalid ANALYTICS_DEPLOYMENT_FINGERPRINT");
  }
  const accountReporting = readAccountReportingConfig(env);
  return {
    sourceUrl: requireValue(env, "ANALYTICS_SOURCE_DATABASE_URL"),
    warehouseUrl: requireValue(env, "ANALYTICS_WAREHOUSE_DATABASE_URL"),
    network: requireValue(env, "ANALYTICS_NETWORK"),
    fingerprint,
    firstCheckpoint: BigInt(first),
    walletKey,
    ...(accountReporting ? { accountReporting } : {}),
  };
}

export function readAccountReportingConfig(
  env: Environment,
): Readonly<{ scope: string }> | null {
  if (env.ANALYTICS_ACCOUNT_REPORTING_ENABLED !== "true") {
    return null;
  }
  const scope = requireValue(env, "ANALYTICS_ACCOUNT_REPORTING_SCOPE");
  if (!/^[0-9a-f]{64}$/.test(scope)) {
    throw new Error("Invalid ANALYTICS_ACCOUNT_REPORTING_SCOPE");
  }
  return { scope };
}

export function analyticsScope(
  config: AnalyticsConfig,
  exclusionVersion: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "bounded-collector-v1",
        ANALYTICS_EXPORT_VERSION,
        "registered-pool-quote-receipts-v1",
        "historical-quote-oracle-60s-100bps-v1",
        config.network,
        config.fingerprint,
        config.firstCheckpoint.toString(),
        config.walletKey,
        exclusionVersion,
      ]),
    )
    .digest("hex");
}

export function requireValue(env: Environment, key: string): string {
  const value = env[key];
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function readApiConfig(env: Environment) {
  const rawPort = env.PORT ?? "8080";
  const port = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT");
  }
  return {
    databaseUrl: requireValue(env, "ANALYTICS_READ_DATABASE_URL"),
    token: requireValue(env, "ANALYTICS_API_TOKEN"),
    port,
    ...(env.ANALYTICS_ACCOUNT_REPORTING_ENABLED === "true"
      ? { accountReportingEnabled: true }
      : {}),
  };
}

export function analyticsPool(
  connectionString: string,
  applicationName: string,
): Pool {
  let url: URL;
  let host: string;
  try {
    url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error();
    }
    host = url.searchParams.get("host") || decodeURIComponent(url.hostname);
  } catch {
    throw new Error("Analytics database URLs must use PostgreSQL");
  }
  if (
    new Set(url.searchParams.keys()).size !==
    [...url.searchParams.keys()].length
  ) {
    throw new Error("Analytics database URLs must not repeat query parameters");
  }
  const local =
    host.startsWith("/") ||
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  if (!local && url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Analytics remote databases require sslmode=verify-full");
  }
  if (
    host.toLowerCase().includes("-pooler.") ||
    url.searchParams.has("options")
  ) {
    throw new Error(
      "Analytics requires direct endpoints without custom connection options",
    );
  }
  for (const key of [
    "statement_timeout",
    "query_timeout",
    "idle_in_transaction_session_timeout",
  ]) {
    url.searchParams.delete(key);
  }
  const pool = new Pool({
    connectionString: url.toString(),
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 12000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
    idle_in_transaction_session_timeout: 15000,
    options: "-c lock_timeout=1000 -c max_parallel_workers_per_gather=0",
  });
  pool.on("error", () => {
    console.error(
      JSON.stringify({
        metric: "analytics.idle_connection_failed",
        service: applicationName,
      }),
    );
  });
  return pool;
}
