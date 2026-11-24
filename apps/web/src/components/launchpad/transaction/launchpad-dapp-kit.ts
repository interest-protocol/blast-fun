import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

/** Where the launchpad remembers its direct-wallet connection, apart from Mission Control's. */
export const LAUNCHPAD_WALLET_STORAGE_KEY = "blast:launchpad:wallet:v1";

const FULLNODES: Readonly<Record<string, string>> = { mainnet: SUI_MAINNET_GRPC_URL };

/**
 * A dApp Kit instance owned by the launchpad for exactly one network: the
 * deployment's. It shares no storage or Slush metadata endpoint with Mission
 * Control's instance.
 */
export function createLaunchpadDAppKit(network: string) {
  const baseUrl = FULLNODES[network];
  if (!baseUrl) throw new RangeError(`No Sui fullnode is configured for ${network}.`);
  return createDAppKit({
    networks: [network],
    defaultNetwork: network,
    createClient: (name) => new SuiGrpcClient({ network: name, baseUrl, format: "text" }),
    slushWalletConfig: typeof window === "undefined" ? null : { appName: "BLAST.FUN" },
    storageKey: LAUNCHPAD_WALLET_STORAGE_KEY,
  });
}

export type LaunchpadDAppKit = ReturnType<typeof createLaunchpadDAppKit>;

const kits = new Map<string, LaunchpadDAppKit>();

/** Share the lazy wallet connection across launchpad routes. */
export function launchpadDAppKit(network: string): LaunchpadDAppKit {
  if (typeof window === "undefined") return createLaunchpadDAppKit(network);
  let kit = kits.get(network);
  if (!kit) {
    kit = createLaunchpadDAppKit(network);
    // Keep listening for disconnects and account changes after a route closes.
    kit.stores.$wallets.listen(() => {});
    kits.set(network, kit);
  }
  return kit;
}
