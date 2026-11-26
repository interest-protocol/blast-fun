"use client";

import dynamic from "next/dynamic";
import { useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import {
  PrivySessionContext,
  privySessionValue,
  type PrivyLoginListener,
  type PrivyRuntime,
} from "#web/components/auth/privy-session.ts";
import type { PrivySessionRuntimeProps } from "./PrivySessionRuntime.tsx";

/** Calls `onUnavailable` once: the SDK's code did not load, so the page stays signed out. */
function RuntimeUnavailable({ onUnavailable }: Readonly<{ onUnavailable: () => void }>) {
  useEffect(onUnavailable, [onUnavailable]);
  return null;
}

type RuntimeComponent = ComponentType<PrivySessionRuntimeProps & Readonly<{ onUnavailable: () => void }>>;

// Privy, WalletConnect and the wallet kits load in their own chunk, never with the page.
// A failed load is kept by its component, so a retry needs a fresh one, which later providers share.
let latestRuntime: RuntimeComponent = runtimeLoader();
function runtimeLoader(): RuntimeComponent {
  return dynamic<PrivySessionRuntimeProps & Readonly<{ onUnavailable: () => void }>>(() => import("./PrivySessionRuntime.tsx").catch(() => RuntimeUnavailable), { ssr: false });
}

/** `load` callers wait here until Privy is ready, or until its code fails to load. */
class PendingStart {
  #runtime: PrivyRuntime | null = null;
  #failed = false;
  #waiting = new Set<Readonly<{ resolve: (runtime: PrivyRuntime) => void; reject: (error: Error) => void }>>();

  /** Resolves with the started runtime; after a failed load, `retry` loads the code again first. */
  wait(retry: () => void): Promise<PrivyRuntime> {
    if (this.#runtime) return Promise.resolve(this.#runtime);
    if (this.#failed) {
      this.#failed = false;
      retry();
    }
    return new Promise((resolve, reject) => this.#waiting.add({ resolve, reject }));
  }

  started(runtime: PrivyRuntime | null): void {
    this.#runtime = runtime;
    if (!runtime) return;
    for (const { resolve } of this.#waiting) resolve(runtime);
    this.#waiting.clear();
  }

  failed(): void {
    this.#failed = true;
    for (const { reject } of this.#waiting) reject(new Error("Privy did not start. Try again."));
    this.#waiting.clear();
  }
}

/**
 * Whether a `PrivySessionProvider` is above: `WalletProvider` mounts it only
 * while `PRIVY_APP_ID` is set. Below it, `usePrivySession` reads the session
 * and loads Privy's SDK on demand.
 */
export function usePrivySessionMounted(): boolean {
  return useContext(PrivySessionContext) !== null;
}

const PRIVY_COOKIE = /(?:^|;\s*)privy-(?:token|session)=/;
const PRIVY_STORED_TOKEN = /^privy:(?:.+:)?(?:token|refresh_token)$/;

/** A Privy session this browser may hold, or an OAuth or mobile wallet sign-in returning to this page. */
function browserPrivySession(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has("privy_oauth_code") || params.has("privy_oauth_state")) return true;
  // A mobile wallet's in-app browser opens the page with these; it has no cookie or storage yet.
  if (params.has("privy_connector") && params.has("privy_wallet_client")) return true;
  if (PRIVY_COOKIE.test(document.cookie)) return true;
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      if (PRIVY_STORED_TOKEN.test(window.localStorage.key(index) ?? "")) return true;
    }
  } catch {
    // Blocked storage holds no Privy session.
  }
  return false;
}

/**
 * The page's Privy session without Privy's SDK on first load. The SDK (about
 * 500 KB gzip with its wallet kits) loads when this browser holds a session
 * (`sessionCookie` from the request, Privy's own storage, or a sign-in
 * returning to the page) or when a sign-in asks for it (`load`). Until it has
 * started, readers see a stable signed-out value: not ready while a session
 * is expected. A failed load leaves the page signed out; the next `load`
 * tries again.
 *
 * Privy's hooks need its provider above them, and `next/dynamic` cannot keep
 * the page mounted while that provider loads above it; swapping it in would
 * remount the whole shell. So the provider renders beside the page and
 * publishes its session through `PrivySessionContext` (`usePrivySession`).
 * Delete this wrapper when Privy's provider can mount late without
 * remounting its children (or Privy ships a hook-free session client): mount
 * `PrivyProvider` lazily around the shell, sign in from a signed-out page and
 * check that the shell keeps its state (an open sheet, a scroll position).
 */
export function PrivySessionProvider({
  appId,
  nonce,
  sessionCookie = false,
  children,
}: Readonly<{ appId: string; nonce: string | null; sessionCookie?: boolean; children: ReactNode }>) {
  // Privy's own storage is read once the page is the browser's; until then a session may exist.
  const hydrated = useHydrated();
  const stored = useMemo(() => hydrated && browserPrivySession(), [hydrated]);
  const expected = sessionCookie || stored;
  const [requested, setRequested] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [Runtime, setRuntimeComponent] = useState<{ component: RuntimeComponent }>(() => ({ component: latestRuntime }));
  const [runtime, setRuntime] = useState<PrivyRuntime | null>(null);
  const [listeners] = useState(() => new Set<PrivyLoginListener>());
  const [pending] = useState(() => new PendingStart());
  // The runtime is published once Privy is ready: that answers every waiting `load`.
  useEffect(() => pending.started(runtime), [pending, runtime]);
  const load = useCallback(() => {
    setRequested(true);
    return pending.wait(() => {
      setUnavailable(false);
      latestRuntime = runtimeLoader();
      setRuntimeComponent({ component: latestRuntime });
    });
  }, [pending]);
  const onUnavailable = useCallback(() => {
    setUnavailable(true);
    pending.failed();
  }, [pending]);
  const subscribe = useCallback((listener: PrivyLoginListener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [listeners]);
  const emit = useCallback<PrivyLoginListener>((event) => {
    for (const listener of listeners) listener(event);
  }, [listeners]);

  const value = useMemo(
    () => privySessionValue(runtime, unavailable || (hydrated && !expected), load, subscribe),
    [expected, hydrated, load, runtime, subscribe, unavailable],
  );
  // A stable element: the SDK re-renders only on its own changes, not on the session it publishes.
  const sdk = useMemo(
    () => requested || expected
      ? <Runtime.component appId={appId} emit={emit} nonce={nonce} onChange={setRuntime} onUnavailable={onUnavailable} />
      : null,
    [Runtime, appId, emit, expected, nonce, onUnavailable, requested],
  );
  return (
    <PrivySessionContext value={value}>
      {children}
      {sdk}
    </PrivySessionContext>
  );
}
