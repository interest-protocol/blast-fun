import { evaluateProtocolAccess, observeDeploymentRuntime, type Venue } from "@interest-protocol/blast-sdk/deployments";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { presaleNode } from "@blast/core/modules/presale/deployment/node.ts";
import { createPresaleDeploymentGate, type PresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";

/** The process's presale deployment and the node that serves it. */
export function presaleDeploymentGate(): PresaleDeploymentGate {
  return processSingleton("presale.deployment-gate", () => {
    const config = runtimeConfig();
    const state = config.presaleDeployment;
    const node = presaleNode(state, config.suiNodeUrl);
    return createPresaleDeploymentGate({ state, node: async () => node });
  });
}

/** Checks the published package identities and current pause mask before preparing a presale transaction. */
export async function presaleSigningIdentity(
  gate: PresaleDeploymentGate,
  options: Readonly<{ signal?: AbortSignal; presalePauseBit?: number; venue?: Venue }> = {},
) {
  const identity = await gate.authorize({ signal: options.signal });
  const manifest = identity.manifest;
  if (!manifest) return identity;
  const baseUrl = presaleNodeUrl(gate.state, runtimeConfig().suiNodeUrl);
  if (!baseUrl) throw new PresaleRouteError("deployment_unavailable");
  const transport = boundedFetch(3_000);
  const client = new SuiGrpcClient({
    network: manifest.network,
    baseUrl,
    format: "text",
    fetch: Object.assign((input: Parameters<typeof transport>[0], init?: RequestInit) => {
      const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signals = [inherited, options.signal].filter((signal) => signal != null);
      return transport(input, signals.length ? { ...init, signal: AbortSignal.any(signals) } : init);
    }, transport),
  });
  const runtime = await observeDeploymentRuntime(client, manifest).catch(() => {
    throw new PresaleRouteError("deployment_unavailable");
  });
  const access = evaluateProtocolAccess({ manifest, mode: "production", runtime });
  if (access.signing !== "enabled" || (access.paused.presale & (options.presalePauseBit ?? 0)) !== 0 ||
      (options.venue !== undefined && !access.venues[options.venue].available)) {
    throw new PresaleRouteError("deployment_unavailable");
  }
  return identity;
}
