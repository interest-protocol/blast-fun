import { z } from "zod";

import { parseBlastTradeFee, type BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import { boundedInteger } from "@blast/core/lib/config/bounded-integer.ts";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import {
  optionalSecret,
  requiredSecret,
  requiredValue,
} from "@blast/core/lib/config/secret.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import {
  ratePolicyOptionsFromEnvironment,
  type RatePolicyRegistryOptions,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { assertPublishedProfile, parseProfile } from "@blast/core/modules/defillama/contracts.ts";
import type { DefillamaSettings } from "@blast/core/modules/defillama/runtime.ts";
import { expectedDeployment, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { BridgeConfiguration } from "@blast/core/modules/presale/bridge/contracts.ts";
import type { AccountSettings } from "@blast/core/modules/presale/contracts/account-settings.ts";
import type { PresaleDeploymentState } from "@blast/core/modules/presale/deployment/contracts.ts";
import { mainnetNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import {
  blastInfraApiKey,
  blastInfraReadOrigin,
  marketDataOrigin,
  type BlastInfraSettings,
} from "@blast/core/modules/read-routing/blast-infra.ts";
import type { CreateFeePolicy } from "@blast/core/modules/social/contracts/create.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { requiredSiteOrigin } from "@blast/core/lib/site-origin.ts";
import { rotatingGateKeys, type GateKeys } from "@blast/core/lib/web-security/gate-cookie.ts";
import { parsePrivyConfig, type PrivyConfig } from "@blast/server/lib/privy-adapter/http-gateway.ts";
import { concurrencyFromEnvironment } from "@blast/server/lib/concurrency.ts";
import {
  cardImageSettingsFromEnvironment,
  type CardImageSettings,
} from "@blast/server/modules/mission-control/card-images/settings.ts";
import { bridgeConfigurationFromEnvironment } from "@blast/server/modules/presale/bridge/activation.ts";
import { presaleSettingsDefaults } from "@blast/server/modules/presale/settings/routes.ts";
import { gasPoolSettings, type GasPoolSettings } from "@blast/server/modules/sponsor/pool-execute.ts";
import {
  sponsorConfigFromEnvironment,
  type SponsorConfig,
} from "@blast/server/modules/sponsor/service.ts";
import { publicReadNamespace, type PublicReadScope } from "@blast/server/modules/public-reads/namespace.ts";
import { configuredFeePolicy } from "@blast/server/modules/social/create/chain.ts";
import { DEFAULT_PRESALE_FOLLOW_LIMITS, type PresaleFollowLimits } from "@blast/server/modules/social/presales/follow-reader.ts";
import {
  creatorClaimSignerFromEnvironment,
  type CreatorClaimSigner,
} from "@blast/server/modules/social/creator-claims/signer.ts";
import { parseTradeProviders } from "@blast/server/modules/social/trades/aggregator.ts";
import {
  accountActivityConfig,
  type AccountActivitySettings,
} from "@blast/server/modules/analytics/config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * What the API's route runtimes read from the environment, parsed once. Boot
 * (`backendConfig`) parses it first, so a missing or weak value stops the
 * process instead of failing requests one by one.
 */
export type RuntimeConfig = Readonly<{
  siteOrigin: string;
  /** Null keeps account telemetry off; invalid enabled settings refuse requests. */
  accountActivity: AccountActivitySettings;
  /** `RATE_LIMIT_SUBJECT_PEPPER`: keys every rate-limit subject hash. */
  subjectPepper: string;
  /** `LAUNCHPAD_SUBJECT_PEPPER`: keys stored launchpad subject hashes. */
  launchpadSubjectPepper: string;
  /** `PRESALE_ADMIN_TOKEN`: the operator bearer for admin routes. */
  adminToken: string;
  /** `ADMIN_LOGIN_ADMISSION_TOKEN`: login admission only; never the admin token. */
  loginAdmissionToken: string;
  cronSecret: string;
  gateKeys: GateKeys;
  privy: PrivyConfig;
  /** `BLAST_NETWORK` + `BLAST_DEPLOYMENT_FINGERPRINT`: required on the API. */
  expectedDeployment: ExpectedDeployment;
  /** The SDK manifest `expectedDeployment` selects; `unavailable` keeps the gate's deployment_unavailable answer. */
  presaleDeployment: PresaleDeploymentState;
  /** `PRESALE_SUI_GRPC_URL` (https only), else the public mainnet fullnode. */
  suiNodeUrl: string;
  /** `BLAST_COIN_SUINS_MAX_CONCURRENCY`, else eight concurrent lookups. */
  coinSuinsMaxConcurrency: number;
  /** `BLAST_INFRA_ORIGIN` and `BLAST_INFRA_API_KEY` (required), `BLAST_INFRA_READ_MODE`/`_ORIGIN` (optional). */
  infra: BlastInfraSettings & Readonly<{ apiKey: string }>;
  /** `PRESALE_BRIDGE_FORWARDING` and `PRESALE_BRIDGE_RELAYER_ADDRESS`; unset keeps the bridge off. */
  bridge: BridgeConfiguration;
  /** `BLAST_TRADE_FEE_BPS` + `BLAST_TRADE_FEE_RECEIVER`; null for no fee. */
  tradeFee: BlastTradeFee | null;
  /** Null while `PRESALE_SPONSOR_ADDRESS` is unset (sponsoring answers service_unavailable). */
  sponsor: SponsorConfig | null;
  /** Null while `PRESALE_GAS_POOL_URL` is unset (execution answers service_unavailable). */
  gasPool: GasPoolSettings | null;
  sponsorRatePolicy: RatePolicyRegistryOptions;
  /** `SOCIAL_TRADE_PROVIDERS`, else the default providers. */
  tradeProviders: readonly string[];
  social: Readonly<{
    createDraftLimit: number;
    createFeePolicy: CreateFeePolicy;
    /** Undefined keeps the route kit's default share. */
    routeMetricSampleRate: number | undefined;
  }>;
  presaleSettingsDefaults: AccountSettings;
  /** Null while `CREATOR_CLAIM_SIGNER_KEY` is unset: account claims stay off. */
  creatorClaimSigner: CreatorClaimSigner | null;
  launchCreatorXBearerToken: string | null;
  launchCreatorXLookupConcurrency: number;
  /** `LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`; null keeps launch asset uploads off. */
  launchAssetBlobToken: string | null;
  cardImages: CardImageSettings;
  /** Null while `DEFILLAMA_READ_DATABASE_URL` is unset. */
  defillama: DefillamaSettings | null;
  /** Null when shared public caching is not configured: reads go uncached. */
  publicReadNamespaces: Readonly<Record<PublicReadScope, string>> | null;
  presaleFollow: PresaleFollowLimits;
  /** The partner quota namespace, hashed from the raw `BLAST_REDIS_NAMESPACE` and deployment identity. */
  quotaNamespace: string;
}>;

/** The process's runtime config, parsed from `process.env` on first use. */
export function runtimeConfig(): RuntimeConfig {
  return processSingleton("runtimeConfig", () => parseRuntimeConfig(process.env));
}

export function parseRuntimeConfig(environment: Environment): RuntimeConfig {
  const adminToken = requiredSecret(environment, "PRESALE_ADMIN_TOKEN");
  const loginAdmissionToken = requiredSecret(environment, "ADMIN_LOGIN_ADMISSION_TOKEN");
  if (loginAdmissionToken === adminToken) {
    throw new Error("ADMIN_LOGIN_ADMISSION_TOKEN must differ from PRESALE_ADMIN_TOKEN.");
  }

  const deployment = requiredDeployment(environment);
  const presaleDeployment = readPresaleDeploymentIdentity(environment);
  const tradeFee = parsed(
    "BLAST_TRADE_FEE_BPS and BLAST_TRADE_FEE_RECEIVER must be set together: 0 to 1000 BPS and a nonzero Sui address.",
    () => parseBlastTradeFee(environment),
  );

  return {
    siteOrigin: requiredSiteOrigin(environment),
    accountActivity: accountActivityConfig(environment),
    subjectPepper: requiredSecret(environment, "RATE_LIMIT_SUBJECT_PEPPER"),
    launchpadSubjectPepper: requiredSecret(environment, "LAUNCHPAD_SUBJECT_PEPPER"),
    adminToken,
    loginAdmissionToken,
    cronSecret: requiredSecret(environment, "CRON_SECRET"),
    gateKeys: rotatingGateKeys(
      requiredSecret(environment, "BLAST_GATE_SECRET"),
      optionalSecret(environment, "BLAST_GATE_SECRET_PREVIOUS"),
    ),
    privy: parsePrivyConfig(environment),
    expectedDeployment: deployment,
    presaleDeployment,
    suiNodeUrl: suiNodeUrl(environment),
    coinSuinsMaxConcurrency: concurrencyFromEnvironment(environment, "BLAST_COIN_SUINS_MAX_CONCURRENCY", 8, 32),
    infra: infraSettings(environment),
    bridge: bridgeConfiguration(environment, presaleDeployment),
    tradeFee,
    sponsor: sponsorConfigFromEnvironment(environment, tradeFee),
    gasPool: gasPoolSettings(environment),
    sponsorRatePolicy: ratePolicyOptionsFromEnvironment(environment),
    tradeProviders: parsed(
      "SOCIAL_TRADE_PROVIDERS must list providers the trade path builds.",
      () => parseTradeProviders(environment.SOCIAL_TRADE_PROVIDERS),
    ),
    social: {
      createDraftLimit: boundedInteger(environment, "SOCIAL_CREATE_DRAFT_LIMIT", 25, 1, 100),
      createFeePolicy: configuredFeePolicy(environment.SOCIAL_CREATE_FEE_POLICY),
      routeMetricSampleRate: routeMetricSampleRate(environment),
    },
    presaleSettingsDefaults: presaleSettingsDefaults(environment),
    creatorClaimSigner: creatorClaimSignerFromEnvironment(environment),
    launchCreatorXBearerToken: environment.LAUNCH_CREATOR_X_BEARER_TOKEN?.trim() || null,
    launchCreatorXLookupConcurrency: concurrencyFromEnvironment(environment, "LAUNCH_CREATOR_X_LOOKUP_CONCURRENCY", 4, 16),
    launchAssetBlobToken: environment.LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN?.trim() || null,
    cardImages: cardImageSettingsFromEnvironment(environment),
    defillama: defillamaSettings(environment, deployment),
    publicReadNamespaces: publicReadNamespaces(environment),
    presaleFollow: {
      fleetSlots: concurrencyFromEnvironment(environment, "BLAST_PRESALE_FOLLOW_FLEET_LIMIT", DEFAULT_PRESALE_FOLLOW_LIMITS.fleetSlots, 32),
      processSlots: concurrencyFromEnvironment(environment, "BLAST_PRESALE_FOLLOW_PROCESS_LIMIT", DEFAULT_PRESALE_FOLLOW_LIMITS.processSlots, 16),
    },
    quotaNamespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
  };
}

/** Runs a parser whose own message may repeat the value; boot sees only `message`. */
function parsed<T>(message: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new Error(message);
  }
}

function requiredDeployment(environment: Environment): ExpectedDeployment {
  const deployment = expectedDeployment(environment);
  if (deployment === null) {
    throw new Error("BLAST_NETWORK and BLAST_DEPLOYMENT_FINGERPRINT must be set.");
  }
  return deployment;
}

/** A refused `PRESALE_SUI_GRPC_URL` stops boot: the public node never stands in for it. */
function suiNodeUrl(environment: Environment): string {
  const url = mainnetNodeUrl(environment);
  if (url === null) {
    throw new Error("PRESALE_SUI_GRPC_URL must be an https URL.");
  }
  return url;
}

function infraSettings(environment: Environment): BlastInfraSettings & Readonly<{ apiKey: string }> {
  requiredValue(environment, "BLAST_INFRA_API_KEY");
  return {
    origin: marketDataOrigin(environment),
    apiKey: blastInfraApiKey(environment) as string,
    readOrigin: blastInfraReadOrigin(environment),
  };
}

/** Unset keeps the bridge off; a set value that does not parse stops boot. */
function bridgeConfiguration(environment: Environment, identity: PresaleDeploymentState): BridgeConfiguration {
  const bridge = bridgeConfigurationFromEnvironment(environment, identity);
  if (environment.PRESALE_BRIDGE_FORWARDING?.trim() && bridge.forwarding === null) {
    throw new Error("PRESALE_BRIDGE_FORWARDING must be blast or circle.");
  }
  if (environment.PRESALE_BRIDGE_RELAYER_ADDRESS?.trim() && bridge.relayerAddress === null) {
    throw new Error("PRESALE_BRIDGE_RELAYER_ADDRESS must be a Sui address.");
  }
  return bridge;
}

/** `SOCIAL_ROUTE_METRIC_SAMPLE_RATE`: a share from 0 to 1; unset or blank keeps the default. */
function routeMetricSampleRate(environment: Environment): number | undefined {
  const raw = environment.SOCIAL_ROUTE_METRIC_SAMPLE_RATE?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!z.number().min(0).max(1).safeParse(value).success) {
    throw new Error("SOCIAL_ROUTE_METRIC_SAMPLE_RATE must be a number from 0 to 1.");
  }
  return value;
}

/** The reporting database and its published profile, checked against the deployment once. */
function defillamaSettings(environment: Environment, deployment: ExpectedDeployment): DefillamaSettings | null {
  const url = environment.DEFILLAMA_READ_DATABASE_URL;
  if (!url) return null;
  const profile = parsed("DEFILLAMA_PROFILE must be the published deployment's profile JSON.", () => {
    const value = parseProfile(JSON.parse(environment.DEFILLAMA_PROFILE ?? "null"));
    assertPublishedProfile(value, deployment);
    return value;
  });
  return { url, profile };
}

/**
 * The shared public-read cache namespaces, hashed from the raw inputs exactly
 * as `publicReadNamespace` reads them. Null when caching is not configured
 * (no replica, no Redis namespace): those reads run uncached.
 */
function publicReadNamespaces(
  environment: Environment,
): Readonly<Record<PublicReadScope, string>> | null {
  try {
    const identity = deploymentIdentity(environment);
    return {
      presales: publicReadNamespace("presales", identity, environment),
      prices: publicReadNamespace("prices", identity, environment),
      market: publicReadNamespace("market", identity, environment),
      social: publicReadNamespace("social", identity, environment),
    };
  } catch {
    return null;
  }
}

