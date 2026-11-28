
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { z } from "zod";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { marketUpstream } from "@blast/server/modules/launchpad-market/shared-runtime.ts";
import { HEALTH_SHARED_MS, type ServiceHealth } from "@blast/core/modules/service-health/contracts.ts";
import { readServiceHealth } from "./read.ts";

const backendHealthSchema = z.object({
  status: z.enum(["ok", "standby", "starting", "draining", "halted", "db_unreachable", "lagging"]),
});

/** Coalesce visitors' probes per process for `HEALTH_SHARED_MS`; the route lets the CDN keep the rest of it. */
export function serviceHealth(): Promise<ServiceHealth> {
  const cache = processSingleton("service-health", () => ({
    reading: null as Promise<ServiceHealth> | null,
    expiresAt: 0,
  }));
  if (!cache.reading || Date.now() >= cache.expiresAt) {
    cache.expiresAt = Date.now() + HEALTH_SHARED_MS;
    cache.reading = readServiceHealth({ backend: readBackend, sui: readSui });
  }
  return cache.reading;
}

async function readBackend(): Promise<ServiceHealth["backend"]> {
  const upstream = marketUpstream();
  const response = await upstream.fetch(new URL("/v1/health", upstream.origin), {
    signal: AbortSignal.timeout(3_000), cache: "no-store", redirect: "error",
  });
  const body = backendHealthSchema.parse(await response.json());
  if (response.status === 200 && body.status === "ok") return "healthy";
  if (response.status === 503 && body.status !== "ok") return "degraded";
  return "unavailable";
}

/** The checkpoint on the process's mainnet node (`RuntimeConfig.suiNodeUrl`). */
async function readSui() {
  const baseUrl = runtimeConfig().suiNodeUrl;
  const client = new SuiGrpcClient({ network: "mainnet", baseUrl, format: "text" });
  const { response } = await client.ledgerService.getServiceInfo({}, { abort: AbortSignal.timeout(3_000) });
  if (response.chain !== "mainnet" || response.checkpointHeight === undefined || !response.timestamp) {
    throw new Error("Sui checkpoint unavailable.");
  }
  return {
    checkpoint: response.checkpointHeight.toString(),
    timestampMs: Number(response.timestamp.seconds) * 1_000 + Math.floor(response.timestamp.nanos / 1_000_000),
  };
}
