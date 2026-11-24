"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

import { WalletNotInstalledError, type ConnectedWallet, type WalletAdapter } from "./link-wallet-flow";

/**
 * The browser wallets behind "Link a Sui wallet": a dApp Kit instance of its
 * own (mainnet only, no auto-connect, its own storage key), apart from
 * Mission Control's and the launchpad's. Slush is always offered through
 * its web wallet; the other choices must be installed as extensions. Loaded
 * only when the sheet opens.
 */
let kit: ReturnType<typeof createSocialLinkDAppKit> | null = null;

function createSocialLinkDAppKit() {
  return createDAppKit({
    networks: ["mainnet"],
    defaultNetwork: "mainnet",
    autoConnect: false,
    createClient: (network) => new SuiGrpcClient({ network, baseUrl: SUI_MAINNET_GRPC_URL }),
    slushWalletConfig: { appName: "BLAST.FUN" },
    storageKey: "blast:social:link-wallet:v1",
  });
}

function instance() {
  kit ??= createSocialLinkDAppKit();
  return kit;
}

export const dappKitWalletAdapter: WalletAdapter = {
  async connect(name: string): Promise<ConnectedWallet> {
    const dAppKit = instance();
    const wanted = name.toLowerCase();
    const wallet = dAppKit.stores.$wallets.get().find((candidate) => candidate.name.toLowerCase().startsWith(wanted));
    if (!wallet) throw new WalletNotInstalledError(name);
    const { accounts } = await dAppKit.connectWallet({ wallet });
    const account = accounts[0];
    if (!account) throw new Error(`${name} returned no account.`);
    return {
      address: account.address,
      async sign(message) {
        return (await dAppKit.signPersonalMessage({ account, message })).signature;
      },
    };
  },
  async release() {
    if (kit?.stores.$connection.get().isConnected) await kit.disconnectWallet();
  },
};
