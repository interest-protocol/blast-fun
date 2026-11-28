"use client";

import { useConnectWallet, useLogin, useLoginWithOAuth, usePrivy, useWallets, type PrivyClientConfig } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { toSolanaWalletConnectors, useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { getWallets, type Wallets } from "@wallet-standard/app";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PrivyAuthProvider } from "#web/components/auth/PrivyAuthProvider.tsx";
import type { PrivyLoginListener, PrivyRuntime } from "#web/components/auth/privy-session.ts";
import { EnableWallets } from "#web/components/auth/privy-wallet-picker.ts";
import { useIsDark } from "#web/components/blast-ui/use-shell-prefs.ts";
import type { PrivySourceWalletsStore, PrivyStart } from "./privy-start.ts";

type WalletConfig = { solana: { connectors: ReturnType<typeof toSolanaWalletConnectors> } };
const documentConfigs = new WeakMap<Document, Map<string, WalletConfig>>();

export type PrivySessionRuntimeProps = Readonly<{
  appId: string;
  nonce: string | null;
  /** The page's start: receives the ready SDK, null when it stops, or a failed start. */
  start: PrivyStart;
  /** The page's source wallets: receives Privy's connected wallets once it is ready, null when it stops. */
  wallets: PrivySourceWalletsStore;
  emit: PrivyLoginListener;
}>;

/**
 * Privy's SDK for the page's session, loaded by `PrivySessionProvider` only
 * when a session or a sign-in needs it. Presale and social pages share
 * Mission Control's app ID and discover installed Solana wallets.
 */
export default function PrivySessionRuntime({ appId, nonce, start, wallets, emit }: PrivySessionRuntimeProps) {
  const theme = useIsDark() ? "dark" : "light";
  return (
    <PrivyAuthProvider key={appId} appId={appId} nonce={nonce} deferWalletPicker externalWallets={sessionWallets(appId)} theme={theme}>
      <PrivySessionBridge emit={emit} start={start} />
      <PrivySourceWallets wallets={wallets} />
    </PrivyAuthProvider>
  );
}

/** Mounts the wallet hooks only while the page reads them (Bridge to Sui is open). */
function PrivySourceWallets({ wallets }: Pick<PrivySessionRuntimeProps, "wallets">) {
  const wanted = useSyncExternalStore(wallets.subscribeWanted, wallets.wanted, wallets.wanted);
  return wanted ? <PrivySourceWalletsBridge wallets={wallets} /> : null;
}

/** Publishes Privy's connected EVM and Solana wallets to the page, which renders outside Privy's provider. */
function PrivySourceWalletsBridge({ wallets }: Pick<PrivySessionRuntimeProps, "wallets">) {
  const { ready } = usePrivy();
  const { connectWallet } = useConnectWallet();
  const { wallets: evm } = useWallets();
  const { wallets: solana } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  useEffect(() => {
    wallets.publish(ready ? { evm, solana, connectWallet, signSolanaTransaction: signTransaction } : null);
  }, [connectWallet, evm, ready, signTransaction, solana, wallets]);
  useEffect(() => () => wallets.publish(null), [wallets]);
  return null;
}

/** Publishes Privy's session and actions to the page, which renders outside Privy's provider. */
function PrivySessionBridge({ start, emit }: Pick<PrivySessionRuntimeProps, "start" | "emit">) {
  const privy = usePrivy();
  const enableWallets = useContext(EnableWallets);
  const { login } = useLogin({
    onComplete: ({ user, wasAlreadyAuthenticated, loginMethod }) =>
      emit({ kind: "login", user, wasAlreadyAuthenticated, loginMethod }),
    onError: (code) => emit({ kind: "login-error", code: String(code) }),
  });
  const { initOAuth } = useLoginWithOAuth({
    onComplete: ({ wasAlreadyAuthenticated }) => emit({ kind: "oauth", wasAlreadyAuthenticated }),
    onError: (code) => emit({ kind: "oauth-error", code: String(code) }),
  });
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const latest = useRef({ privy, enableWallets, login, initOAuth, createWallet, signRawHash });
  useEffect(() => {
    latest.current = { privy, enableWallets, login, initOAuth, createWallet, signRawHash };
  });
  // Stable actions: readers keep their callbacks while Privy re-renders.
  const [actions] = useState(() => ({
    getAccessToken: () => latest.current.privy.getAccessToken(),
    logout: () => latest.current.privy.logout(),
    login: (...args: Parameters<PrivyRuntime["login"]>) => latest.current.login(...args),
    initOAuth: (...args: Parameters<PrivyRuntime["initOAuth"]>) => latest.current.initOAuth(...args),
    createWallet: (...args: Parameters<PrivyRuntime["createWallet"]>) => latest.current.createWallet(...args),
    signRawHash: (...args: Parameters<PrivyRuntime["signRawHash"]>) => latest.current.signRawHash(...args),
    enableWallets: (...args: Parameters<PrivyRuntime["enableWallets"]>) => latest.current.enableWallets?.(...args),
  }));
  const { ready, authenticated, user, error } = privy;
  // Writes Privy's state into the page's start: the ready session, or a failed start
  // (Privy sets `error` and stays not ready).
  useEffect(() => {
    if (ready) start.publish({ ...actions, authenticated, user });
    else if (error) start.fail();
  }, [actions, authenticated, error, ready, start, user]);
  useEffect(() => () => start.publish(null), [start]);
  return null;
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
