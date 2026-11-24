"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";

import { ClaimRunnerProvider } from "../claim/use-claims";
import type { ClaimPath } from "../claim/claims";
import type { CommitKit } from "../commit/commit-kit";
import type { TradeKit } from "../trade/trade-kit";
import { viaEntryOf } from "../commit/commit-view";
import { useSignInGate } from "../SignInGate";
import { presaleHref } from "./shell-bridge-model";

/**
 * A post can open the sign-in sheet through the shell's `openSignIn` action
 * or the commit and sale dialogs provided by `FeedOverlaysProvider`:
 *
 * - `openCommit` ("Blast", `aria-haspopup="dialog"`, "Through Mira's post");
 * - `openSale` ("View presale", the presale chip).
 *
 * Until a dialog is mounted, each control is a link to the presale page; until
 * the sign-in sheet registers, the rocket is a link to `/sign-in?next=…`.
 */
export type FeedOverlays = Readonly<{
  openCommit?: (item: FeedItem) => void;
  openSale?: (presaleId: string) => void;
  /**
   * The commit dialog with no post in hand: the sale page's own "Blast in",
   * crediting the post a shared link came through (`via=<entry_id>`, T-024)
   * when there is one.
   */
  openCommitTo?: (presaleId: string, sourceEntryId: string | null) => void;
  /**
   * The dialog's host, for a surface that commits without the dialog (Blast
   * mode's composer and quick blast, R3-54, and hold to blast on every Blast
   * button, R3-13): the same flow, quoted and sent from outside. See
   * `commit/commit-kit.ts`.
   */
  commitKit?: CommitKit;
  /**
   * The claim transaction (R3-63, `claim/ClaimHost.tsx`): every claim button
   * — Blast mode's Act now and side panel, the sale page's side box — runs it.
   * Absent while claiming is off (no mainnet deployment) or for a visitor.
   */
  claimPath?: ClaimPath;
  /**
   * The trade path (R3-55, `trade/TradeHost.tsx`): one quote and one swap
   * execution for every surface that trades — Blast mode's composer, the
   * coins sheet (R3-33), the sale page's bar (R3-34). See `trade/trade-kit.ts`.
   */
  tradeKit?: TradeKit;
}>;

const FeedOverlaysContext = createContext<FeedOverlays>({});

/** Provides the commit and sale dialogs' openers (merged over any outer provider). */
export function FeedOverlaysProvider({ value, children }: Readonly<{ value: FeedOverlays; children: ReactNode }>) {
  const outer = useContext(FeedOverlaysContext);
  const merged = useMemo(() => ({ ...outer, ...value }), [outer, value]);
  return <FeedOverlaysContext value={merged}><ClaimRunnerProvider path={merged.claimPath}>{children}</ClaimRunnerProvider></FeedOverlaysContext>;
}

/** The commit host's kit, or null where no commit host is mounted (a development fixture, a page outside the shell). */
export function useCommitKit(): CommitKit | null {
  return useContext(FeedOverlaysContext).commitKit ?? null;
}

/** The shell's trade path, or null where no trade host is mounted (a development fixture, a page outside the shell). */
export function useTradeKit(): TradeKit | null {
  return useContext(FeedOverlaysContext).tradeKit ?? null;
}

/** The shell's claim transaction, or undefined where none is mounted or claiming is off. */
export function useShellClaimPath(): ClaimPath | undefined {
  return useContext(FeedOverlaysContext).claimPath;
}

/** Which dialogs are mounted: a control is a button opening one, else a link to its fallback page. */
export type FeedOverlaysMounted = Readonly<{ commit: boolean; sale: boolean }>;

export type FeedOverlayOpeners = Readonly<{
  /** Runs the shell's sign-in sheet; false when none is registered (the caller's link then navigates). */
  openSignIn(): boolean;
  openCommit(item: FeedItem): void;
  openSale(presaleId: string): void;
  /** The commit dialog for a sale, with an optional source post; null while no dialog is mounted. */
  openCommitTo: ((presaleId: string, sourceEntryId: string | null) => void) | null;
  signedIn: boolean;
  signInHref: string;
  mounted: FeedOverlaysMounted;
}>;

/** The openers a post uses, each with its fallback. */
export function useFeedOverlays(): FeedOverlayOpeners {
  const overlays = useContext(FeedOverlaysContext);
  const run = useShellActions();
  const gate = useSignInGate();
  const openSignIn = useCallback(() => run("openSignIn"), [run]);
  const openSale = useCallback((presaleId: string) => {
    if (overlays.openSale) overlays.openSale(presaleId);
    else window.location.assign(presaleHref(presaleId));
  }, [overlays]);
  const openCommit = useCallback((item: FeedItem) => {
    if (overlays.openCommit) overlays.openCommit(item);
    else if (item.presale) window.location.assign(presaleHref(item.presale.presale_id));
  }, [overlays]);
  const mounted = useMemo<FeedOverlaysMounted>(() => ({ commit: Boolean(overlays.openCommit), sale: Boolean(overlays.openSale) }), [overlays]);
  return {
    openSignIn,
    openSale,
    openCommit,
    openCommitTo: overlays.openCommitTo ?? null,
    signedIn: gate.signedIn,
    signInHref: gate.signInHref,
    mounted,
  };
}

/**
 * The sale page's commit (`SaleCommit`, UI-09/10's hand-off): its "Blast in"
 * opens the commit dialog, and a sale page reached through a shared post's
 * link (`?via=<entry_id>`) credits that post. Undefined while no commit dialog
 * is mounted, which keeps the page's own disabled state and note. The source
 * is read at the press, from the URL as it is then; the route stores it only
 * if it is visible (T-024), so a made-up id credits nobody.
 */
export function useSaleCommit(): Readonly<{ open: (presaleId: string) => void }> | undefined {
  const { openCommitTo } = useFeedOverlays();
  return useMemo(
    () => (openCommitTo ? { open: (presaleId: string) => openCommitTo(presaleId, viaEntryOf(window.location.search)) } : undefined),
    [openCommitTo],
  );
}
