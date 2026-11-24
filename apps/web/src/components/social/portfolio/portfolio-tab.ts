"use client";

import { writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { useSyncExternalStore } from "react";
import { captureLists } from "#web/components/blast-ui/list-restoration.ts";
import { portfolioPath, portfolioTabNamed, portfolioTabAt, type PortfolioTab } from "#web/components/blast-ui/portfolio-navigation.ts";

export const PORTFOLIO_TAB_KEY = "blast.pfTab2";
const listeners = new Set<() => void>();
let memory: PortfolioTab = "coins";
type TabStorage = Pick<Storage, "getItem" | "setItem">;

export function readPortfolioTab(store: TabStorage | null): PortfolioTab {
  try {
    const value: unknown = JSON.parse(store?.getItem(PORTFOLIO_TAB_KEY) ?? "null");
    return portfolioTabNamed(value) ?? "coins";
  } catch { return "coins"; }
}

/** Next copies its routing fields itself; passing its bypass flags would skip URL synchronization. */
function navigationState() {
  const state = { ...window.history.state, blastOrigin: undefined };
  delete state.__NA;
  delete state._N;
  return state;
}

/**
 * Native History integrates with Next without replacing the Portfolio shell. `replace` corrects the
 * current entry instead of adding one (a tab this request does not offer), so Back never returns to it.
 */
export function setPortfolioTab(tab: PortfolioTab, { replace = false }: Readonly<{ replace?: boolean }> = {}): void {
  memory = tab;
  if (typeof window !== "undefined") {
    if (portfolioTabAt(window.location.pathname, window.location.search) !== null) {
      captureLists();
      const url = new URL(window.location.href);
      url.pathname = portfolioPath(tab);
      url.searchParams.delete("tab");
      if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"](navigationState(), "", url);
    }
    writeBrowserStorage("local", PORTFOLIO_TAB_KEY, JSON.stringify(tab));
  }
  for (const listener of listeners) listener();
}

export function canonicalizePortfolio(): void {
  const url = new URL(window.location.href);
  const requested = portfolioTabAt(url.pathname, url.search);
  if (requested === null) return;
  url.pathname = portfolioPath(requested);
  url.searchParams.delete("tab");
  window.history.replaceState(navigationState(), "", url);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => { listeners.delete(listener); window.removeEventListener("popstate", listener); };
}
const snapshot = (): PortfolioTab => typeof window === "undefined" ? memory : portfolioTabAt(window.location.pathname, window.location.search) ?? memory;
export function usePortfolioTab(initial: PortfolioTab = "coins"): PortfolioTab {
  return useSyncExternalStore(subscribe, snapshot, () => initial);
}
