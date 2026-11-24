"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

import { signInHref } from "../sign-in-gate";
import type { AccessTokenSource } from "../viewer-state-client";
import { useViewerStateStore } from "../ViewerState";
import { cachedWatchlistCalls } from "./watchlist-cache";
import { WatchlistStore, type ToggleOutcome, type WatchlistCalls, type WatchlistRows, type WatchlistSnapshot } from "./watchlist-store";

/**
 * The watchlist in the page (UI-12, OA-11). `SocialShell` mounts the
 * provider once; a signed-in viewer gets a store (a fresh one for another
 * callsign), a visitor none. Stars read the ids once per viewer; the right
 * column's card reads its rows when it mounts, and again after a star or a
 * presale follow changes.
 */
const WatchlistContext = createContext<WatchlistStore | null>(null);
const NO_TOKEN: AccessTokenSource = () => Promise.resolve(null);
const IDLE: WatchlistSnapshot = { status: "idle", ids: new Set(), rows: null };
const subscribeNothing = () => () => undefined;

export function WatchlistProvider({
  signedIn,
  viewerKey,
  getAccessToken,
  calls,
  children,
}: Readonly<{ signedIn: boolean; viewerKey: string; getAccessToken?: AccessTokenSource; calls?: WatchlistCalls; children: ReactNode }>) {
  const client = useAppQueryClient();
  const make = () => new WatchlistStore({ getAccessToken: getAccessToken ?? NO_TOKEN }, calls ?? cachedWatchlistCalls(client));
  const [held, setHeld] = useState(() => ({ key: viewerKey, store: make() }));
  // Another viewer: a fresh store, keeping the tree (React's derived-state pattern).
  if (held.key !== viewerKey) setHeld({ key: viewerKey, store: make() });
  useEffect(() => {
    held.store.setOptions({ getAccessToken: getAccessToken ?? NO_TOKEN });
  }, [held.store, getAccessToken]);
  // The card lists followed presales too (OA-17): every follow written on the page reaches it.
  const viewerState = useViewerStateStore();
  useEffect(() => {
    if (!viewerState) return;
    return viewerState.subscribeFollowWrites((target, following) => {
      if (target.kind === "presale") held.store.followChanged(target.presale_id, following);
    });
  }, [viewerState, held.store]);
  return <WatchlistContext value={signedIn && held.key === viewerKey ? held.store : null}>{children}</WatchlistContext>;
}

/** The viewer's watchlist snapshot (idle and empty for a visitor). Reading it asks for the ids once. */
export function useWatchlistSnapshot(): WatchlistSnapshot {
  const store = useContext(WatchlistContext);
  useEffect(() => {
    if (store) void store.loadIds();
  }, [store]);
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, store?.getSnapshot ?? (() => IDLE), () => IDLE);
}

export function useWatchlistRetry(): () => void {
  const store = useContext(WatchlistContext);
  return () => void store?.loadIds();
}

/** The card's rows: read when the card mounts (null for a visitor). */
export function useWatchlistRows(): Readonly<{ rows: WatchlistRows | null; signedIn: boolean; retry: () => void }> {
  const store = useContext(WatchlistContext);
  const snapshot = useWatchlistSnapshot();
  useEffect(() => {
    if (store) void store.loadRows();
  }, [store]);
  return { rows: store ? snapshot.rows : null, signedIn: store !== null, retry: () => void store?.loadRows() };
}

/** `presale_id` is the star's key: a presale id, or a bonding-curve coin's type. */
type StarTarget = Pick<SocialPresaleSummary, "presale_id" | "name"> & Partial<SocialPresaleSummary>;

/**
 * A presale's star: whether it is on, and the toggle. A visitor's tap opens
 * the sign-in sheet (`/sign-in?next=` without the shell). A refusal puts
 * the star back and says so (OA-13).
 */
export function useWatchStar(presale: StarTarget): Readonly<{ on: boolean; toggle: () => void }> {
  const store = useContext(WatchlistContext);
  const snapshot = useWatchlistSnapshot();
  const run = useShellActions();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const on = snapshot.ids.has(presale.presale_id);
  const toggle = useCallback(() => {
    if (!store) {
      if (!run("openSignIn")) router.push(signInHref(pathname));
      return;
    }
    const next = !store.has(presale.presale_id);
    void store.toggle(presale, next).then((outcome: ToggleOutcome) => {
      if (outcome === "limit") toast("Your watchlist is full", { sub: "Remove a saved coin to add another." });
      else if (outcome === "failed") toast("Couldn’t update your watchlist", { sub: "Nothing changed. Try again." });
    });
  }, [store, presale, run, router, pathname, toast]);
  return { on, toggle };
}

export type { WatchlistRows, WatchlistSnapshot };
