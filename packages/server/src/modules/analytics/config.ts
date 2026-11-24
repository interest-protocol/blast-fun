import { createHash } from "node:crypto";
import type { PoolConfig } from "pg";
import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function accountActivityConfig(env: Environment) {
  try {
    return parseAccountActivityConfig(env);
  } catch {
    return "unavailable" as const;
  }
}

export type AccountActivitySettings = ReturnType<typeof accountActivityConfig>;

function parseAccountActivityConfig(env: Environment) {
  if (env.ANALYTICS_ACCOUNT_ACTIVITY_ENABLED !== "true") {
    return null;
  }
  const key = required(env, "ANALYTICS_ACCOUNT_HASH_KEY");
  if (key.length < 32) {
    throw new Error("Invalid account activity configuration");
  }
  const origin = trustedUrl(
    "ANALYTICS_ACCOUNT_SITE_ORIGIN",
    required(env, "ANALYTICS_ACCOUNT_SITE_ORIGIN"),
    { shape: "origin", http: "loopback" },
  );
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        "blast-account-v1",
        "existing-owner-v1",
        createHash("sha256").update(key).digest("hex"),
      ]),
    )
    .digest("hex");
  return {
    key,
    scope,
    origin: origin.origin,
    appId: required(env, "PRIVY_APP_ID"),
    verificationKey: required(env, "PRIVY_JWT_VERIFICATION_KEY"),
    identity: activityPoolConfig(
      required(env, "ANALYTICS_IDENTITY_DATABASE_URL"),
      "blast-analytics-identity",
    ),
    warehouse: activityPoolConfig(
      required(env, "ANALYTICS_INGRESS_DATABASE_URL"),
      "blast-analytics-ingress",
    ),
  };
}

/** Parse the effective host once; never pass driver-overriding URL options through. */
export function activityPoolConfig(connectionString: string, applicationName: string): PoolConfig {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) {
      throw new Error();
    }
    const entries = [...url.searchParams.keys()];
    if (
      new Set(entries).size !== entries.length ||
      entries.some((key) => !["host", "sslmode"].includes(key))
    ) {
      throw new Error();
    }
    const host =
      url.searchParams.get("host") || decodeURIComponent(url.hostname).replace(/^\[|\]$/g, "");
    const local = host.startsWith("/") || ["localhost", "127.0.0.1", "::1"].includes(host);
    const mode = url.searchParams.get("sslmode");
    if (
      !host ||
      host.toLowerCase().includes("-pooler.") ||
      (!local && mode !== "verify-full") ||
      (local && mode !== null && !["disable", "verify-full"].includes(mode))
    ) {
      throw new Error();
    }
    const user = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!user || !database) {
      throw new Error();
    }
    return {
      host,
      user,
      database,
      password: () => decodeURIComponent(url.password),
      port: url.port ? Number(url.port) : 5432,
      ssl: !local || mode === "verify-full" ? { rejectUnauthorized: true } : false,
      application_name: applicationName,
      max: 1,
      connectionTimeoutMillis: 1500,
      statement_timeout: 2000,
      query_timeout: 3000,
      idleTimeoutMillis: 10000,
      idle_in_transaction_session_timeout: 3000,
      options: "-c lock_timeout=250 -c max_parallel_workers_per_gather=0",
      sslnegotiation: "postgres",
    };
  } catch {
    throw new Error("Invalid account activity database configuration");
  }
}

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error("Invalid account activity configuration");
  }
  return value;
}
