import { SuiGrpcClient } from "@mysten/sui/grpc";

import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";
import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import type { ChainIdentifierNode, PresaleDeploymentState } from "./contracts.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * `PRESALE_SUI_GRPC_URL` without its trailing slash: https only, in every
 * environment. Undefined when unset; null when set to anything else, which
 * no caller replaces with the public fullnode.
 */
function configuredNodeUrl(environment: Environment): string | null | undefined {
  const configured = environment.PRESALE_SUI_GRPC_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = trustedUrl("PRESALE_SUI_GRPC_URL", configured, {
      shape: "url",
      http: "never",
    });
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * The Sui node presale code reads and checks the identity against: the
 * process's mainnet node (`mainnetNodeUrl`, parsed once at boot). Null when
 * no identity is in force, which the gate answers with `deployment_unavailable`.
 */
export function presaleNodeUrl(state: PresaleDeploymentState, nodeUrl: string): string | null {
  return state.status === "ready" ? nodeUrl : null;
}

/**
 * The mainnet node the server's other chain reads use (trading, wallets,
 * sales, vesting, health): `PRESALE_SUI_GRPC_URL` (https only), else the public mainnet fullnode. Null when it is set but
 * refused: callers answer unavailable, never the public node. Server
 * environments only; the URL may embed a provider key.
 */
export function mainnetNodeUrl(environment: Environment): string | null {
  const configured = configuredNodeUrl(environment);
  return configured === undefined ? SUI_MAINNET_GRPC_URL : configured;
}

/**
 * The identity check's view of the node: one gRPC client per process, whose
 * chain identifier is read fresh each time, with the abort signal passed to
 * the transport. The client's own `core.getChainIdentifier` caches its
 * pending read and only races the signal, so one stalled read would keep
 * failing every later check until that request ended; this read is never
 * cached, and an aborted read closes its request.
 */
export function presaleNode(state: PresaleDeploymentState, nodeUrl: string): ChainIdentifierNode | null {
  const baseUrl = presaleNodeUrl(state, nodeUrl);
  if (!baseUrl || state.status !== "ready") return null;
  const client = new SuiGrpcClient({ network: state.identity.network, baseUrl, format: "text" });
  return Object.freeze({
    core: Object.freeze({
      async getChainIdentifier(options?: { signal?: AbortSignal }) {
        const { response } = await client.ledgerService.getServiceInfo({}, { abort: options?.signal });
        if (!response.chainId) throw new Error("The node reported no chain identifier.");
        return { chainIdentifier: response.chainId };
      },
    }),
  });
}
