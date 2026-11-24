"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import type { SocialFollowTarget } from "@blast/core/web/contracts/follows.ts";
import type { SocialViewerBackers } from "@blast/core/web/contracts/viewer-state.ts";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import type { AccessTokenSource } from "./viewer-state-client";
import { ViewerStateStore } from "./viewer-state-store";

const ViewerStateContext = createContext<ViewerStateStore | null>(null);

const NO_TOKEN: AccessTokenSource = () => Promise.resolve(null);
const subscribeNothing = () => () => undefined;

/**
 * A signed-in viewer's state store for everything below it. `SocialViewerProvider`
 * always mounts it, so signing in or out never remounts the page below it;
 * a visitor (`active` false) gets no store, so nothing is read or written.
 * A new `resetKey` (another callsign) starts a fresh store, whose answers are
 * kept in the page's server-state cache under that callsign (OA-38). `getAccessToken`
 * gives the viewer's Privy access token; it may change identity between
 * renders.
 */
export function ViewerStateProvider({
  getAccessToken,
  active = true,
  resetKey = "",
  children,
}: Readonly<{ getAccessToken?: AccessTokenSource; active?: boolean; resetKey?: string; children: ReactNode }>) {
  const client = useAppQueryClient();
  const make = () => new ViewerStateStore({ getAccessToken: getAccessToken ?? NO_TOKEN, client, scope: resetKey });
  const [held, setHeld] = useState(() => ({ key: resetKey, store: make() }));
  // Another viewer: replace the store during render (React's derived-state pattern), keeping the tree.
  if (held.key !== resetKey) setHeld({ key: resetKey, store: make() });
  const store = held.store;
  useLayoutEffect(() => {
    store.setActive(active);
    return () => store.setActive(false);
  }, [store, active]);
  // Reads run a turn after the first commit and writes on a tap, so the latest getter is in place.
  useEffect(() => {
    store.setAccessTokenSource(getAccessToken ?? NO_TOKEN);
  }, [store, getAccessToken]);
  return <ViewerStateContext value={active && held.key === resetKey ? store : null}>{children}</ViewerStateContext>;
}

/** The signed-in viewer's store, or null for a visitor. */
export function useViewerStateStore(): ViewerStateStore | null {
  return useContext(ViewerStateContext);
}

/**
 * Whether the signed-in viewer follows `target` (undefined while unknown, and
 * always for a visitor). Mounting asks the store for it; every control on the
 * page that mounts in the same turn is read in one batched request.
 */
export function useViewerFollow(target: SocialFollowTarget): boolean | undefined {
  const store = useViewerStateStore();
  const callsign = target.kind === "account" ? target.callsign : null;
  const presaleId = target.kind === "presale" ? target.presale_id : null;
  useEffect(() => {
    if (!store) return;
    store.want(callsign !== null ? { callsigns: [callsign] } : { presaleIds: [presaleId!] });
  }, [store, callsign, presaleId]);
  const read = () =>
    store?.following(callsign !== null ? { kind: "account", callsign } : { kind: "presale", presale_id: presaleId! });
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, read, () => undefined);
}

/** Pending is shared by every control for the same account, including Undo. */
export function useViewerFollowPending(target: SocialFollowTarget): boolean {
  const store = useViewerStateStore();
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => store?.followPending(target) ?? false, () => false);
}

/** A failed relationship read is unknown, never an instruction to follow. */
export function useViewerFollowReadFailed(target: SocialFollowTarget): boolean {
  const store = useViewerStateStore();
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => store?.followReadFailed(target) ?? false, () => false);
}

/** Incoming follows are independent of whether the viewer follows back. */
export function useViewerFollowsYou(callsign: string): boolean {
  const store = useViewerStateStore();
  useEffect(() => { store?.want({ followsYou: [callsign] }); }, [store, callsign]);
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => store?.followsYou(callsign) === true, () => false);
}

/** The signed-in viewer's reaction keys on an item (undefined while unknown, and for a visitor), batched like follows. */
export function useViewerReactions(entryId: string): readonly string[] | undefined {
  const store = useViewerStateStore();
  useEffect(() => {
    store?.want({ entryIds: [entryId] });
  }, [store, entryId]);
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => store?.reactions(entryId), () => undefined);
}

/**
 * The signed-in viewer's followed named backers of a presale (undefined while
 * unknown, and for a visitor), for a post's facepile; batched like follows.
 */
export function useViewerBackers(presaleId: string | null): SocialViewerBackers | undefined {
  const store = useViewerStateStore();
  useEffect(() => {
    if (store && presaleId) store.want({ backersOf: [presaleId] });
  }, [store, presaleId]);
  return useSyncExternalStore(
    store?.subscribe ?? subscribeNothing,
    () => (presaleId ? store?.backers(presaleId) : undefined),
    () => undefined,
  );
}

/**
 * The relationship tag of an account for the signed-in viewer (the live tape,
 * FEATURE-MAP §17): "Following" when the viewer follows it, else "Follows you"
 * when it follows the viewer, else null (also while unknown, for a visitor and
 * for the viewer's own account). Batched like follows.
 */
export function useRelationTag(callsign: string | null, own: boolean): "Following" | "Follows you" | null {
  const store = useViewerStateStore();
  const active = Boolean(store && callsign && !own);
  useEffect(() => {
    if (store && callsign && !own) store.want({ callsigns: [callsign], followsYou: [callsign] });
  }, [store, callsign, own]);
  return useSyncExternalStore(
    store?.subscribe ?? subscribeNothing,
    () => {
      if (!active || !store || !callsign) return null;
      if (store.following({ kind: "account", callsign }) === true) return "Following";
      return store.followsYou(callsign) === true ? "Follows you" : null;
    },
    () => null,
  );
}

/** The viewer's reaction keys on an item as first read (undefined while unknown): what its public count includes. */
export function useViewerReactionsAtRead(entryId: string): readonly string[] | undefined {
  const store = useViewerStateStore();
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => store?.reactionsAtRead(entryId), () => undefined);
}
