import type { BackendFleetEnvelope } from "../src/app/config/fleet.ts";

/** Synthetic arithmetic only; no hosted capacity or provider ceilings are inferred. */
export function fleetFixture(): BackendFleetEnvelope {
  return {
    evidence: "local-synthetic-not-capacity-proof",
    visibleSubscribedTabs: 10_000,
    utilizationPercent: 80,
    api: {
      replicas: 4,
      primaryPoolMax: 10,
      replicaPoolMax: 10,
      maxInflight: 64,
      cacheRedis: false,
      defillama: false,
    },
    hints: { replicas: 26, maxHintStreams: 512 },
    reserved: {
      primaryClients: 4,
      replicaClients: 4,
      reportingClients: 0,
      quotaRedisClients: 4,
      cacheRedisClients: 0,
      infraHintSockets: 4,
      quoteWorkers: 0,
    },
    ceilings: {
      primaryClients: 100,
      replicaClients: 100,
      reportingClients: 0,
      quotaRedisClients: 100,
      cacheRedisClients: 0,
      infraHintSockets: 100,
      quoteWorkers: 8,
    },
  };
}
