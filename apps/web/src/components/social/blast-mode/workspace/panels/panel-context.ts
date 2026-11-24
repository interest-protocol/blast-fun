"use client";

import { createContext } from "react";

export const PanelHeadingContext = createContext<HTMLElement | null>(null);
export const PanelAssetContext = createContext<(() => void) | null>(null);
/** In the focus board, the chart card hands the panel its header row (identity, full screen, options). */
export const PanelHeaderSlotContext = createContext<((element: HTMLElement | null) => void) | null>(null);

export const CoinDetailsSlots = createContext<Readonly<{
  chart?: HTMLElement | null;
  trade?: HTMLElement | null;
  /** The chart card's "On chart" row: overlay chips, with the plot's Reset view at its end. */
  overlays?: HTMLElement | null;
  reset?: HTMLElement | null;
  visible?: boolean;
}>>({});
/** "Following only" in the market context card: Holders and Trades list only accounts the viewer follows. */
export const FollowingOnlyContext = createContext(false);
/** Turns Following only off, for an empty filtered list's "Show all" action (audit inventory). */
export const ClearFollowingOnlyContext = createContext<(() => void) | null>(null);
