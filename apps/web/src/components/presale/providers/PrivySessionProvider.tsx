"use client";

import type { PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { getWallets, type Wallets } from "@wallet-standard/app";
import { createContext, useContext, type ReactNode } from "react";
import { PrivyAuthProvider } from "#web/components/auth/PrivyAuthProvider.tsx";
import { useIsDark } from "#web/components/blast-ui/use-shell-prefs.ts";

const PrivySessionMounted = createContext(false);
type WalletConfig = {
  wallets: ReturnType<Wallets["get"]>;
  walletSet: ReadonlySet<ReturnType<Wallets["get"]>[number]>;
  externalWallets: NonNullable<PrivyClientConfig["externalWallets"]>;
  release: () => void;
};
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
    <PrivyAuthProvider appId={appId} nonce={nonce} externalWallets={sessionWallets(appId)} theme={theme}>
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
  const wallets = getWallets().get();
  const previous = configs.get(appId);
  if (
    previous &&
    wallets.length === previous.wallets.length &&
    wallets.every((wallet) => previous.walletSet.has(wallet))
  ) {
    return previous.externalWallets;
  }
  previous?.release();
  // The factory subscribes immediately; per-render memoization leaks discarded Strict Mode renders.
  const connectors = toSolanaWalletConnectors();
  // Privy's onMount reattaches listeners without rescanning wallets registered during absence.
  const entry = {
    wallets,
    walletSet: new Set(wallets),
    externalWallets: { solana: { connectors } },
    release: connectors.onUnmount,
  };
  configs.set(appId, entry);
  return entry.externalWallets;
}
