import { SuiGrpcClient } from "@mysten/sui/grpc";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { configuredSigningChain } from "@blast/core/modules/launchpad-coin/signing-chain.ts";
import type { LaunchReadChain } from "./fresh.ts";

/**
 * The released deployment's server reads, on the process's mainnet node
 * (`RuntimeConfig.suiNodeUrl`) rather than the public fullnode browsers sign
 * through. Null while none is released.
 */
export async function configuredLaunchReadChain(): Promise<LaunchReadChain | null> {
  const released = configuredSigningChain();
  if (!released) return null;
  const client = new SuiGrpcClient({ network: released.network, baseUrl: runtimeConfig().suiNodeUrl, format: "text", fetch: boundedFetch(8_000) });
  return { client, manifest: released.manifest };
}
