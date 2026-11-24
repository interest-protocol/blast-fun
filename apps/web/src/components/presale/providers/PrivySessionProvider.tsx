"use client";

import type { PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { getWallets, type Wallets } from "@wallet-standard/app";
import { createContext, useContext, type ReactNode } from "react";
import { PrivyAuthProvider } from "#web/components/auth/PrivyAuthProvider.tsx";
import { useIsDark } from "#web/components/blast-ui/use-shell-prefs.ts";

const PrivySessionMounted = createContext(false);
type WalletConfig = { solana: { connectors: ReturnType<typeof toSolanaWalletConnectors> } };
const documentConfigs = new WeakMap<Document, Map<string, WalletConfig>>();

/**
 * Whether a `PrivySessionProvider` is above: `WalletProvider` mounts it only
 * while `PRIVY_APP_ID` is set. Privy's `usePrivy` answers "not ready" without
 * a provider, but `useLogin` and `useLogout` throw, so a component that calls
 * them (the sign-in page) checks this first.
 */
export function usePrivySessionMounted(): boolean {
  return useContext(PrivySessionMounted);
}

/** Presale and social pages share Mission Control's app ID and discover installed Solana wallets. */
export function PrivySessionProvider({
  appId,
  nonce,
  children,
}: Readonly<{ appId: string; nonce: string | null; children: ReactNode }>) {
  const theme = useIsDark() ? "dark" : "light";
  return (
    <PrivyAuthProvider key={appId} appId={appId} nonce={nonce} deferWalletPicker externalWallets={sessionWallets(appId)} theme={theme}>
      <PrivySessionMounted value>{children}</PrivySessionMounted>
    </PrivyAuthProvider>
  );
}

function sessionWallets(appId: string): PrivyClientConfig["externalWallets"] {
  if (typeof document === "undefined") {
    return undefined;
  }
  let configs = documentConfigs.get(document);
  if (!configs) {
    configs = new Map();
    documentConfigs.set(document, configs);
  }
  const previous = configs.get(appId);
  if (previous && matchesDiscoveredWallets(previous.solana.connectors, getWallets().get())) return previous;
  previous?.solana.connectors.onUnmount();
  // The factory subscribes immediately; per-render memoization leaks discarded Strict Mode renders.
  const connectors = toSolanaWalletConnectors();
  // Privy's onMount reattaches listeners without rescanning wallets registered during absence.
  const entry = { solana: { connectors } };
  configs.set(appId, entry);
  return entry;
}

// The SDK observes registrations while mounted. Its WalletConnect adapter stays the same
// across those events. A registration missed during absence requires a fresh scan.
function matchesDiscoveredWallets(connectors: ReturnType<typeof toSolanaWalletConnectors>, wallets: ReturnType<Wallets["get"]>): boolean {
  // The factory takes the first external Solana wallet of each name.
  const eligible = new Map<string, (typeof wallets)[number]>();
  for (const wallet of wallets) {
    if (eligible.has(wallet.name) || !wallet.chains.some((chain) => chain.startsWith("solana:"))) continue;
    if ("privy:" in wallet.features && "isPrivyWallet" in wallet && wallet.isPrivyWallet) continue;
    eligible.set(wallet.name, wallet);
  }
  const detected = connectors.get().filter((connector) => connector.walletBranding.id !== "walletconnect_solana");
  return detected.length === eligible.size && detected.every(({ wallet }) => eligible.get(wallet.name) === wallet);
}
