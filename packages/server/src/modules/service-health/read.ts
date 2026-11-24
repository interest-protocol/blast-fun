import { HEALTH_STALE_MS, type ServiceHealth } from "@blast/core/modules/service-health/contracts.ts";

type HealthDependencies = Readonly<{
  backend: () => Promise<ServiceHealth["backend"]>;
  sui: () => Promise<{ checkpoint: string; timestampMs: number }>;
  now?: () => number;
}>;

/** Independent probes: a responding indexer does not establish Sui availability. */
export async function readServiceHealth(dependencies: HealthDependencies): Promise<ServiceHealth> {
  const [backend, sui] = await Promise.allSettled([
    Promise.resolve().then(dependencies.backend),
    Promise.resolve().then(dependencies.sui),
  ]);
  const checkedAt = (dependencies.now ?? Date.now)();
  const checkpoint = sui.status === "fulfilled" ? sui.value : null;
  const valid = checkpoint !== null && /^\d+$/.test(checkpoint.checkpoint)
    && Number.isSafeInteger(checkpoint.timestampMs) && checkpoint.timestampMs > 0
    && checkpoint.timestampMs <= checkedAt + 5_000;

  return {
    checkedAt,
    backend: backend.status === "fulfilled" ? backend.value : "unavailable",
    sui: valid ? {
      ...checkpoint,
      status: checkedAt - checkpoint.timestampMs <= HEALTH_STALE_MS ? "healthy" : "stale",
    } : { status: "unavailable", checkpoint: null, timestampMs: null },
  };
}
