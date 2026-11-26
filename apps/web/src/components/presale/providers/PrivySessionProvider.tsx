"use client";

import dynamic from "next/dynamic";
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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

// Privy, WalletConnect and the wallet kits load in their own chunk, never with the page.
const PrivySessionRuntime = dynamic<PrivySessionRuntimeProps & Readonly<{ onUnavailable: () => void }>>(
  () => import("./PrivySessionRuntime.tsx").catch(() => RuntimeUnavailable),
  { ssr: false },
);

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

/** A Privy session this browser may hold, or an OAuth sign-in returning to this page. */
function browserPrivySession(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has("privy_oauth_code") || params.has("privy_oauth_state")) return true;
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
 * 550 KB gzip with its wallet kits) loads when this browser holds a session
 * (`sessionCookie` from the request, or Privy's own storage) or when a
 * sign-in asks for it (`load`). Until it has started, readers see a stable
 * signed-out value: not ready while a session is expected.
 *
 * Privy's hooks need its provider above them, and `next/dynamic` cannot keep
 * the page mounted while that provider loads above it; swapping it in would
 * remount the whole shell. So the provider renders beside the page and
 * publishes its session through `PrivySessionContext` (`usePrivySession`).
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
  const [runtime, setRuntime] = useState<PrivyRuntime | null>(null);
  const [listeners] = useState(() => new Set<PrivyLoginListener>());

  const load = useCallback(() => setRequested(true), []);
  const onUnavailable = useCallback(() => setUnavailable(true), []);
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
      ? <PrivySessionRuntime appId={appId} emit={emit} nonce={nonce} onChange={setRuntime} onUnavailable={onUnavailable} />
      : null,
    [appId, emit, expected, nonce, onUnavailable, requested],
  );
  return (
    <PrivySessionContext value={value}>
      {children}
      {sdk}
    </PrivySessionContext>
  );
}
