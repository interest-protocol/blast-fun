"use client";

import { useConnectWallet, useWallets } from "@privy-io/react-auth";
import { useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { useCallback, useMemo } from "react";

import { usePreparePrivyWalletPicker } from "#web/components/auth/privy-wallet-picker.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";

import { useBalancesContext } from "../coins/balances.tsx";

import type { BridgeConfig } from "./bridge-config.ts";
import { displayAmount } from "./bridge-model.ts";
import { explorerLink, type BridgeRow, type EvmWallet, type SolanaWallet } from "./bridge-sdk.ts";
import { BridgeForm, type BridgeWallets } from "./BridgeForm.tsx";
import { mayanSdk } from "./mayan-sdk.ts";

export type BridgeCardProps = Readonly<{
  config: BridgeConfig;
  blastAddress: string | null;
  signedIn: boolean;
  onSignIn: () => void;
}>;

/** `eip155:8453` → 8453. */
function evmChainId(chainId: string): number | null {
  const id = Number(chainId.split(":")[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The lazy chunk behind the Bridge to Sui screen: Privy's connected EVM and
 * Solana wallets, the Mayan SDK, and what happens when a bridge arrives.
 * Connecting a source wallet never links it to the Blast account.
 */
export default function BridgeCard({ config, blastAddress, signedIn, onSignIn }: BridgeCardProps) {
  // WalletConnect QR and Coinbase only list once the picker is prepared.
  usePreparePrivyWalletPicker(true);
  const { connectWallet } = useConnectWallet();
  const { wallets: evmWallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const toast = useToast();
  const balances = useBalancesContext();
  const sdk = useMemo(() => mayanSdk(config), [config]);

  // The person's own wallet, never a Privy embedded one: that is not where their coins are. The newest EVM one is the one just connected.
  const evmSource = evmWallets.filter((wallet) => wallet.walletClientType !== "privy").sort((a, b) => b.connectedAt - a.connectedAt)[0] ?? null;
  const solanaSource = solanaWallets.find(({ standardWallet }) => standardWallet.name !== "Privy" && !("isPrivyWallet" in standardWallet && standardWallet.isPrivyWallet)) ?? null;

  const evm = useMemo<EvmWallet | null>(() => evmSource && {
    kind: "evm",
    address: evmSource.address,
    chainId: evmChainId(evmSource.chainId),
    switchChain: (chainId) => evmSource.switchChain(chainId),
    provider: () => evmSource.getEthereumProvider(),
  }, [evmSource]);

  const solana = useMemo<SolanaWallet | null>(() => solanaSource && {
    kind: "solana",
    address: solanaSource.address,
    signTransaction: async (transaction) => (await signTransaction({ transaction, wallet: solanaSource, chain: "solana:mainnet" })).signedTransaction,
  }, [signTransaction, solanaSource]);

  const wallets = useMemo<BridgeWallets>(() => ({
    evm,
    solana,
    connect: (kind) => connectWallet({ walletChainType: kind === "evm" ? "ethereum-only" : "solana-only" }),
  }), [connectWallet, evm, solana]);

  const onArrived = useCallback((row: BridgeRow, toAmount: string | null) => {
    balances.changed();
    toast(`Arrived · ${toAmount ? displayAmount(toAmount, row.toSymbol) : row.toSymbol}`, {
      sub: "In your Blast wallet",
      href: explorerLink(row.hash),
      link: "View on Mayan",
    });
  }, [balances, toast]);

  return (
    <BridgeForm
      blastAddress={blastAddress}
      config={config}
      onArrived={onArrived}
      onSignIn={onSignIn}
      sdk={sdk}
      signedIn={signedIn}
      wallets={wallets}
    />
  );
}
