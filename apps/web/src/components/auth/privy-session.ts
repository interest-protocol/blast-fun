"use client";

import type { User, useLogin, useLoginWithOAuth } from "@privy-io/react-auth";
import type { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { createContext, useContext, useEffect, useRef } from "react";

import type { WalletMode } from "./privy-wallet-picker.ts";

/**
 * Privy's SDK once it has loaded and started: its session and the actions
 * Blast uses. Only the lazily loaded runtime (`PrivySessionRuntime.tsx`)
 * creates one, so pages import Privy's types here, never its code.
 */
export type PrivyRuntime = Readonly<{
  authenticated: boolean;
  user: User | null;
  getAccessToken: () => Promise<string | null>;
  logout: () => Promise<void>;
  login: ReturnType<typeof useLogin>["login"];
  initOAuth: ReturnType<typeof useLoginWithOAuth>["initOAuth"];
  createWallet: ReturnType<typeof useCreateWallet>["createWallet"];
  signRawHash: ReturnType<typeof useSignRawHash>["signRawHash"];
  enableWallets: (mode: WalletMode | null) => void;
}>;

/** Privy's login outcomes. Every flow hears them all, so each answers only the attempt it opened. */
export type PrivyLoginEvent =
  | Readonly<{ kind: "login"; user: User; wasAlreadyAuthenticated: boolean; loginMethod: string | null }>
  | Readonly<{ kind: "login-error"; code: string }>
  | Readonly<{ kind: "oauth"; wasAlreadyAuthenticated: boolean }>
  | Readonly<{ kind: "oauth-error"; code: string }>;

export type PrivyLoginListener = (event: PrivyLoginEvent) => void;

/**
 * The page's Privy session. Until the SDK has started it reads signed out:
 * ready when no session is expected, still loading while one is.
 */
export type PrivySession = Readonly<{
  ready: boolean;
  authenticated: boolean;
  user: User | null;
  getAccessToken: () => Promise<string | null>;
  logout: () => Promise<void>;
  /** The started SDK, or null until a session or a sign-in needs it. */
  runtime: PrivyRuntime | null;
  /**
   * Starts loading the SDK and resolves with its runtime once Privy is ready.
   * Rejects if Privy does not start (its code did not load or it reported an error);
   * the next call mounts it again. It never gives up on a slow start: a click wraps it in
   * `startPrivy`.
   */
  load: () => Promise<PrivyRuntime>;
  subscribe: (listener: PrivyLoginListener) => () => void;
}>;

export const PrivySessionContext = createContext<PrivySession | null>(null);

const noAccessToken = async (): Promise<string | null> => null;
const noLogout = async (): Promise<void> => undefined;
const noop = (): void => undefined;
const noRuntime = async (): Promise<PrivyRuntime> => {
  throw new Error("Privy is not configured.");
};

/** Pages without Privy configured: ready and signed out. */
const PRIVY_ABSENT: PrivySession = {
  ready: true,
  authenticated: false,
  user: null,
  getAccessToken: noAccessToken,
  logout: noLogout,
  runtime: null,
  load: noRuntime,
  subscribe: () => noop,
};

/** The session state while the SDK is not running (`ready` says whether a session may still appear). */
export function privySessionValue(
  runtime: PrivyRuntime | null,
  ready: boolean,
  load: PrivySession["load"],
  subscribe: PrivySession["subscribe"],
): PrivySession {
  if (!runtime) return { ...PRIVY_ABSENT, ready, load, subscribe };
  const { authenticated, user, getAccessToken, logout } = runtime;
  return { ready: true, authenticated, user, getAccessToken, logout, runtime, load, subscribe };
}

// Privy's API client sets no request timeout, so a hung startup request leaves it neither
// ready nor failed. A click stops waiting after this; Privy keeps starting in the background.
export const PRIVY_CLICK_TIMEOUT_MS = 15_000;

/**
 * `load` for a click: rejects after 15 s so the button can say "try again". The
 * timeout ends only this click's wait; it never stops Privy or marks its start failed.
 */
export function startPrivy(load: PrivySession["load"]): Promise<PrivyRuntime> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Privy is taking too long to start. Try again.")), PRIVY_CLICK_TIMEOUT_MS);
    load().finally(() => clearTimeout(timer)).then(resolve, reject);
  });
}

/** The Privy session above (`PrivySessionProvider`), or a signed-out one without it. */
export function usePrivySession(): PrivySession {
  return useContext(PrivySessionContext) ?? PRIVY_ABSENT;
}

/** Hears Privy's login outcomes while mounted. */
export function usePrivyLoginEvents(listener: PrivyLoginListener): void {
  const { subscribe } = usePrivySession();
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}
