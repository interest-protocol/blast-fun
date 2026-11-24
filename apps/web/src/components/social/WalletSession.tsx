"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import {
  endWalletSession,
  hasWalletSessionHint,
  signInWithWallet,
  type WalletSigner,
  type WalletSignInResult,
} from "#web/components/sign-in/wallet-sign-in-client.ts";

/**
 * The page's Sui wallet session (Sui wallet sign-in, OA-16). Privy is not
 * involved: the wallet signs one challenge, the web app sets its own
 * HttpOnly session cookie, and every social route accepts that cookie when
 * no Privy token is sent. Script never sees the session; the readable hint
 * cookie says one may exist, and `me` (read with the cookie) says whether it
 * does. A route that finds the session gone clears both cookies.
 */
export type WalletSession = Readonly<{
  /** Sui wallet sign-in is offered: always, under the social feed. */
  available: boolean;
  /** This browser holds the wallet session hint. */
  active: boolean;
  /** Connects the wallet, signs the challenge and starts the session. */
  signIn(signer: WalletSigner): Promise<WalletSignInResult>;
  /** Ends the wallet session (no-op without one). */
  end(): Promise<void>;
  /** Re-reads the hint, after a response that may have cleared it. */
  refresh(): void;
}>;

const NONE: WalletSession = {
  available: false,
  active: false,
  signIn: async () => "failed",
  end: async () => undefined,
  refresh: () => undefined,
};

const WalletSessionContext = createContext<WalletSession>(NONE);

/** The page's wallet session (none without a `WalletSessionProvider`). */
export function useWalletSession(): WalletSession {
  return useContext(WalletSessionContext);
}

// The hint cookie as an external store: the routes set and clear it, then `changed()` re-reads it.
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed(): void {
  for (const listener of listeners) listener();
}
const hintSnapshot = () => hasWalletSessionHint(document.cookie);
const noHint = () => false;
const loadWalletSigner = () => import("#web/components/sign-in/sui-wallet-signer.ts");

/** Provides the wallet session to the viewer, the `me` read, the sign-in sheet and sign-out. */
export function WalletSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const active = useSyncExternalStore(subscribe, hintSnapshot, noHint);
  const signIn = useCallback(async (signer: WalletSigner) => {
    const result = await signInWithWallet(signer);
    changed();
    return result;
  }, []);
  const end = useCallback(async () => {
    if (!hasWalletSessionHint(document.cookie)) return;
    await endWalletSession();
    // Sign-in keeps the wallet connected for trades; sign-out drops it. Loaded on demand: dApp Kit stays out of this bundle.
    await loadWalletSigner().then(({ forgetWalletConnection }) => forgetWalletConnection()).catch(() => undefined);
    changed();
  }, []);
  const value = useMemo<WalletSession>(() => ({ available: true, active, signIn, end, refresh: changed }), [active, signIn, end]);
  return <WalletSessionContext value={value}>{children}</WalletSessionContext>;
}
