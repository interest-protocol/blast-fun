import {
  BLAST_DEPLOYMENTS,
  BLAST_NETWORKS,
  type BlastDeploymentInput,
  type BlastNetwork,
} from "@interest-protocol/blast-sdk/deployments";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const FULLNODES: Readonly<Partial<Record<BlastNetwork, string>>> = { mainnet: SUI_MAINNET_GRPC_URL };

/** The released deployment on `BLAST_NETWORK` and its fullnode: where the server reads and browsers sign. */
function releasedChain(environment: Environment) {
  const network = environment.BLAST_NETWORK?.trim() as BlastNetwork | undefined;
  if (!network || !BLAST_NETWORKS.includes(network)) return null;
  const deployment = BLAST_DEPLOYMENTS[network];
  const baseUrl = FULLNODES[network];
  if (!deployment || !baseUrl) return null;
  return { network, baseUrl, manifest: deployment };
}

/** What a browser needs to sign launchpad actions: a released deployment and its fullnode. Serializable. */
export type SigningChainConfig = Readonly<{
  network: BlastNetwork;
  baseUrl: string;
  manifest: BlastDeploymentInput;
  mode: "production";
}>;

/**
 * Where browsers sign launchpad actions (the coin page's Complete migration):
 * the released Blast deployment on `BLAST_NETWORK` and its fullnode. Null
 * while none is released.
 */
export function configuredSigningChain(environment: Environment = process.env): SigningChainConfig | null {
  const released = releasedChain(environment);
  return released && { ...released, mode: "production" };
}
