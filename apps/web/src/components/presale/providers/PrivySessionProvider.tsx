"use client";

import dynamic from "next/dynamic";
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import {
  PrivySessionContext,
  privySessionValue,
  type PrivyLoginListener,
} from "#web/components/auth/privy-session.ts";
import type { PrivySessionRuntimeProps } from "./PrivySessionRuntime.tsx";
import { PrivyStart } from "./privy-start.ts";

/** Marks the start failed: the SDK's code did not load, so the page stays signed out. */
function RuntimeUnavailable({ start }: Pick<PrivySessionRuntimeProps, "start">) {
  useEffect(() => start.fail(), [start]);
  return null;
}

type RuntimeComponent = ComponentType<PrivySessionRuntimeProps>;

// Privy, WalletConnect and the wallet kits load in their own chunk, never with the page.
// `next/dynamic` keeps a failed load, so the failure swaps in a fresh loader at once:
// the retry, and any provider mounted later, loads the chunk again.
let latestRuntime: RuntimeComponent = runtimeLoader();
function runtimeLoader(): RuntimeComponent {
  const runtime = dynamic<PrivySessionRuntimeProps>(
    () => import("./PrivySessionRuntime.tsx").catch(() => {
      if (latestRuntime === runtime) latestRuntime = runtimeLoader();
      return RuntimeUnavailable;
    }),
    { ssr: false },
  );
  return runtime;
}

// Privy's API client sets no request timeout, so a hung startup request leaves it neither
// ready nor failed. Nothing else would end that wait.
const PRIVY_START_TIMEOUT_MS = 15_000;

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
 * is expected. A failed start (the code did not load, Privy reported an
 * error, or it was not ready within 15 s) unmounts the SDK and leaves the
 * page signed out; the next `load` mounts it again.
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
  const [Runtime, setRuntimeComponent] = useState<{ component: RuntimeComponent }>(() => ({ component: latestRuntime }));
  const [listeners] = useState(() => new Set<PrivyLoginListener>());
  const [start] = useState(() => new PrivyStart());
  const { runtime, failed, attempt } = useSyncExternalStore(start.subscribe, start.state, start.state);
  useEffect(() => () => start.stop(), [start]);
  const load = useCallback(() => {
    setRequested(true);
    return start.wait(() => setRuntimeComponent({ component: latestRuntime }));
  }, [start]);
  const active = !failed && (requested || expected);
  useEffect(() => {
    if (!active || runtime) return;
    const timer = setTimeout(() => start.fail(), PRIVY_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [active, attempt, runtime, start]);
  const subscribe = useCallback((listener: PrivyLoginListener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [listeners]);
  const emit = useCallback<PrivyLoginListener>((event) => {
    for (const listener of listeners) listener(event);
  }, [listeners]);

  const value = useMemo(
    () => privySessionValue(runtime, failed || (hydrated && !expected), load, subscribe),
    [expected, failed, hydrated, load, runtime, subscribe],
  );
  // A stable element: the SDK re-renders only on its own changes, not on the session it publishes.
  // Each retry mounts a fresh SDK (`attempt`), never the one that failed.
  const sdk = useMemo(
    () => active
      ? <Runtime.component key={attempt} appId={appId} emit={emit} nonce={nonce} start={start} />
      : null,
    [Runtime, active, appId, attempt, emit, nonce, start],
  );
  return (
    <PrivySessionContext value={value}>
      {children}
      {sdk}
    </PrivySessionContext>
  );
}
