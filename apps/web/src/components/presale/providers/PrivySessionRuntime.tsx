"use client";

import { useLogin, useLoginWithOAuth, usePrivy, type PrivyClientConfig } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { getWallets, type Wallets } from "@wallet-standard/app";
import { useContext, useEffect, useRef, useState } from "react";
import { PrivyAuthProvider } from "#web/components/auth/PrivyAuthProvider.tsx";
import type { PrivyLoginListener, PrivyRuntime } from "#web/components/auth/privy-session.ts";
import { EnableWallets } from "#web/components/auth/privy-wallet-picker.ts";
import { useIsDark } from "#web/components/blast-ui/use-shell-prefs.ts";

type WalletConfig = { solana: { connectors: ReturnType<typeof toSolanaWalletConnectors> } };
const documentConfigs = new WeakMap<Document, Map<string, WalletConfig>>();

export type PrivySessionRuntimeProps = Readonly<{
  appId: string;
  nonce: string | null;
  /** Receives the started SDK, and null when it stops. */
  onChange: (runtime: PrivyRuntime | null) => void;
  emit: PrivyLoginListener;
}>;

/**
 * Privy's SDK for the page's session, loaded by `PrivySessionProvider` only
 * when a session or a sign-in needs it. Presale and social pages share
 * Mission Control's app ID and discover installed Solana wallets.
 */
export default function PrivySessionRuntime({ appId, nonce, onChange, emit }: PrivySessionRuntimeProps) {
  const theme = useIsDark() ? "dark" : "light";
  return (
    <PrivyAuthProvider key={appId} appId={appId} nonce={nonce} deferWalletPicker externalWallets={sessionWallets(appId)} theme={theme}>
      <PrivySessionBridge emit={emit} onChange={onChange} />
    </PrivyAuthProvider>
  );
}

/** Publishes Privy's session and actions to the page, which renders outside Privy's provider. */
function PrivySessionBridge({ onChange, emit }: Pick<PrivySessionRuntimeProps, "onChange" | "emit">) {
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
  const { ready, authenticated, user } = privy;
  useEffect(() => {
    onChange(ready ? { ...actions, authenticated, user } : null);
  }, [actions, authenticated, onChange, ready, user]);
  useEffect(() => () => onChange(null), [onChange]);
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
