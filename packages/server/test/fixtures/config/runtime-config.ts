import { processSingleton, takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { parseRuntimeConfig, type RuntimeConfig } from "@blast/server/config/runtime-config.ts";
import { bridgeConfigurationFromEnvironment } from "@blast/server/modules/presale/bridge/activation.ts";

/** Every value `parseRuntimeConfig` requires, synthetic and valid. Tests only. */
export const RUNTIME_TEST_ENVIRONMENT = {
  NEXT_PUBLIC_SITE_URL: "https://blast.test",
  RATE_LIMIT_SUBJECT_PEPPER: "p".repeat(32),
  LAUNCHPAD_SUBJECT_PEPPER: "l".repeat(32),
  PRESALE_ADMIN_TOKEN: "a".repeat(32),
  ADMIN_LOGIN_ADMISSION_TOKEN: "m".repeat(32),
  CRON_SECRET: "c".repeat(32),
  BLAST_GATE_SECRET: "g".repeat(32),
  PRIVY_APP_ID: "synthetic-privy-app",
  PRIVY_APP_SECRET: "synthetic-privy-secret",
  PRIVY_JWT_VERIFICATION_KEY: "synthetic-privy-verification-key",
  BLAST_NETWORK: "mainnet",
  BLAST_DEPLOYMENT_FINGERPRINT: "f".repeat(64),
  BLAST_INFRA_ORIGIN: "https://infra.blast.test",
  BLAST_INFRA_API_KEY: "i".repeat(32),
  BLAST_REDIS_NAMESPACE: "mainnet:test",
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Points `runtimeConfig()` at `RUNTIME_TEST_ENVIRONMENT` plus `overrides` (an
 * undefined value deletes the variable): sets `process.env`, drops the parsed
 * slot and the limiter built from it, and installs a fresh parse with `replace` laid over it.
 */
export function installRuntimeConfig(overrides: Environment = {}, replace: Partial<RuntimeConfig> = {}): RuntimeConfig {
  for (const [name, value] of Object.entries({ ...RUNTIME_TEST_ENVIRONMENT, ...overrides })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  takeProcessSingleton("runtimeConfig");
  takeProcessSingleton("mission-control.rate-limiter");
  const config: RuntimeConfig = Object.freeze({ ...parseRuntimeConfig(process.env), ...replace });
  return processSingleton("runtimeConfig", () => config);
}

/**
 * `installRuntimeConfig` with the presale deployment read from a fixture manifest
 * (`PRESALE_DEPLOYMENT_MANIFEST`), which the API itself never selects: it
 * always serves the SDK manifest `BLAST_DEPLOYMENT_FINGERPRINT` names. The
 * bridge configuration is rebuilt over that identity.
 */
export function installRuntimeConfigWithManifest(manifest: string, overrides: Environment = {}): RuntimeConfig {
  const environment = { ...RUNTIME_TEST_ENVIRONMENT, ...overrides };
  const presaleDeployment = readPresaleDeploymentIdentity({
    ...environment,
    BLAST_NETWORK: undefined,
    BLAST_DEPLOYMENT_FINGERPRINT: undefined,
    PRESALE_DEPLOYMENT_MANIFEST: manifest,
  });
  return installRuntimeConfig(overrides, {
    presaleDeployment,
    bridge: bridgeConfigurationFromEnvironment(environment, presaleDeployment),
  });
}

/** The same loopback database under a second URL: boot refuses a replica URL equal to the primary's. */
export function localReplicaUrl(database: string): string {
  const url = new URL(database);
  url.searchParams.set("application_name", "blast-replica-fixture");
  return url.href;
}
