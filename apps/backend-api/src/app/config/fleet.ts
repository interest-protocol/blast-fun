import { ACTIVITY_HINT_STREAM_BUDGET } from "@blast/core/modules/backend-api/stream-budget.ts";
import { DEFILLAMA_READ_POOL_MAX } from "@blast/core/modules/defillama/contracts.ts";
import { marketStreamEnabled } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import {
  PARTNER_VERIFIER_POOL_SETTINGS,
  poolSettingsFromEnvironment,
  replicaPoolSettingsFromEnvironment,
} from "@blast/core/modules/database/pool-settings.ts";
import { SOCIAL_TRADE_QUOTE_WORKERS } from "@blast/core/modules/social/contracts/trades.ts";
import { createHash } from "node:crypto";
import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;
const resources = z.strictObject({
  primaryClients: z.number().int().min(0).max(1_000_000),
  replicaClients: z.number().int().min(0).max(1_000_000),
  reportingClients: z.number().int().min(0).max(1_000_000),
  quotaRedisClients: z.number().int().min(0).max(1_000_000),
  cacheRedisClients: z.number().int().min(0).max(1_000_000),
  infraHintSockets: z.number().int().min(0).max(1_000_000),
  quoteWorkers: z.number().int().min(0).max(1_000_000),
});
const schema = z.strictObject({
  evidence: z.string().min(1).max(128),
  visibleSubscribedTabs: positive(1_000_000),
  marketSubscribedTabs: z.number().int().min(0).max(1_000_000).optional(),
  legacyMarketStreams: z.number().int().min(0).max(1_000_000).optional(),
  utilizationPercent: positive(100),
  api: z.strictObject({
    replicas: positive(32),
    primaryPoolMax: positive(50),
    replicaPoolMax: positive(50),
    maxInflight: positive(256),
    cacheRedis: z.boolean(),
    defillama: z.boolean(),
  }),
  hints: z.strictObject({
    replicas: z.number().int().min(2).max(32),
    maxHintStreams: positive(ACTIVITY_HINT_STREAM_BUDGET.maxClients),
    marketStream: z.boolean().optional(),
    sharedBrowserStream: z.boolean().optional(),
  }),
  reserved: resources,
  ceilings: resources,
});

export type BackendFleetEnvelope = z.infer<typeof schema>;

type LocalSettings = Readonly<{
  role: "api" | "hints";
  maxHintStreams: number;
  maxInflight: number;
  maxApiReplicas?: number;
}>;

function positive(max: number) {
  return z.number().int().min(1).max(max);
}

/** Validate declared resource arithmetic; this neither discovers replicas nor proves capacity. */
export function validateBackendFleet(environment: Environment, local: LocalSettings) {
  const raw = environment.BLAST_BACKEND_FLEET_CONFIG;
  if (raw === undefined && local.role === "api") {
    return undefined;
  }
  if (!raw || raw.length > 32_768) {
    throw new Error("An explicit backend fleet envelope is required.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid backend fleet envelope JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid backend fleet envelope fields.");
  }
  const plan = parsed.data;
  if (local.role === "api") {
    if (
      !local.maxApiReplicas ||
      plan.api.replicas > local.maxApiReplicas ||
      plan.api.maxInflight !== local.maxInflight ||
      plan.api.primaryPoolMax !== poolSettingsFromEnvironment(environment).max ||
      plan.api.replicaPoolMax !== replicaPoolSettingsFromEnvironment(environment).max ||
      plan.api.cacheRedis !== Boolean(environment.BLAST_CACHE_REDIS_URL) ||
      plan.api.defillama !== Boolean(environment.DEFILLAMA_READ_DATABASE_URL)
    ) {
      throw new Error("Backend fleet API settings differ from this process.");
    }
  } else if (plan.hints.maxHintStreams !== local.maxHintStreams) {
    throw new Error("Backend fleet hint settings differ from this process.");
  }
  const marketTabs = marketSubscriberDemand(plan, environment, local.role);
  const streamsAfterFailure = Math.floor(
    ((plan.hints.replicas - 1) * plan.hints.maxHintStreams * plan.utilizationPercent) / 100,
  );
  if (
    streamsAfterFailure <
    plan.visibleSubscribedTabs + additionalMarketStreams(plan, marketTabs)
  ) {
    throw new Error("Backend fleet cannot cover declared streams after one process failure.");
  }

  const api = plan.api.replicas;
  const hints = plan.hints.replicas;
  const reporting = plan.api.defillama ? DEFILLAMA_READ_POOL_MAX : 0;
  // Reporting may alias either endpoint; charging all three ceilings is conservative.
  const demand = {
    primaryClients:
      api * (plan.api.primaryPoolMax + PARTNER_VERIFIER_POOL_SETTINGS.max + reporting),
    replicaClients: api * (plan.api.replicaPoolMax + reporting),
    reportingClients: api * reporting,
    quotaRedisClients: 2 * (api + hints),
    cacheRedisClients: plan.api.cacheRedis ? api : 0,
    // Only hints processes hold an engine socket: the shared market one, when enabled.
    infraHintSockets: hints * Number(Boolean(plan.hints.marketStream)),
    quoteWorkers: api * SOCIAL_TRADE_QUOTE_WORKERS,
  };
  const totals = { ...demand };
  for (const key of Object.keys(demand) as (keyof typeof demand)[]) {
    totals[key] += plan.reserved[key];
    if (totals[key] > plan.ceilings[key]) {
      throw new Error(`Backend fleet exceeds its declared ${key} ceiling.`);
    }
  }
  return Object.freeze({
    fingerprint: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    demand: Object.freeze(demand),
    totals: Object.freeze(totals),
    streamsAfterFailure,
    measuredCapacity: false as const,
  });
}

function marketSubscriberDemand(
  plan: BackendFleetEnvelope,
  environment: Environment,
  role: LocalSettings["role"],
): number {
  if (role === "hints" && Boolean(plan.hints.marketStream) !== marketStreamEnabled(environment)) {
    throw new Error("Backend fleet market stream settings differ from this process.");
  }
  const marketTabs = plan.marketSubscribedTabs ?? 0;
  if (
    plan.hints.marketStream
      ? marketTabs < 1 || marketTabs > plan.visibleSubscribedTabs
      : marketTabs !== 0
  ) {
    throw new Error("Backend fleet requires bounded market subscriber demand when enabled.");
  }
  return marketTabs;
}

function additionalMarketStreams(plan: BackendFleetEnvelope, marketTabs: number) {
  if (!plan.hints.sharedBrowserStream) {
    if (plan.legacyMarketStreams !== undefined) {
      throw new Error("Legacy market stream reserve requires shared browser mode.");
    }
    return marketTabs;
  }
  if (
    !plan.hints.marketStream ||
    plan.legacyMarketStreams === undefined ||
    plan.legacyMarketStreams > marketTabs
  ) {
    throw new Error(
      "Shared browser mode requires an explicit bounded legacy market stream reserve.",
    );
  }
  return plan.legacyMarketStreams;
}
