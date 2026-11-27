"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { startPrivy, usePrivySession, usePrivySourceWallets, type PrivySourceWallets } from "#web/components/auth/privy-session.ts";
import { usePreparePrivyWalletPicker } from "#web/components/auth/privy-wallet-picker.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";

import { useBalancesContext } from "../coins/balances.tsx";

import { displayAmount } from "./bridge-model.ts";
import { explorerLink, type BridgeRow, type EvmWallet, type SolanaWallet } from "./bridge-sdk.ts";
import { BridgeForm, type BridgeWallets } from "./BridgeForm.tsx";
import { BridgeLoading } from "./BridgeLoading.tsx";
import { mayanSdk } from "./mayan-sdk.ts";

export type BridgeCardProps = Readonly<{
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
 *
 * Privy's provider is never above the page (`PrivySessionProvider`), so the
 * card never calls Privy's hooks: it starts the SDK and reads the wallets the
 * runtime publishes, showing the skeleton until they arrive.
 */
export default function BridgeCard(props: BridgeCardProps) {
  // WalletConnect QR and Coinbase only list once the picker is prepared; this also starts Privy.
  usePreparePrivyWalletPicker(true);
  const { load } = usePrivySession();
  const source = usePrivySourceWallets();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    startPrivy(load).catch(() => setFailed(true));
  }, [load]);
  // `BridgeScreen`'s boundary says the card could not load and offers a retry, which starts Privy again.
  if (failed && !source) throw new Error("Privy did not start for Bridge to Sui.");
  if (!source) return <BridgeLoading />;
  return <BridgeReady {...props} source={source} />;
}

function BridgeReady({ blastAddress, signedIn, onSignIn, source }: BridgeCardProps & Readonly<{ source: PrivySourceWallets }>) {
  const { evm: evmWallets, solana: solanaWallets, connectWallet, signSolanaTransaction: signTransaction } = source;
  const toast = useToast();
  const balances = useBalancesContext();
  const sdk = useMemo(() => mayanSdk(), []);

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
      onArrived={onArrived}
      onSignIn={onSignIn}
      sdk={sdk}
      signedIn={signedIn}
      wallets={wallets}
    />
  );
}
