"use client";

import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import type { DataView, WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { canonicalCoinType } from "./coin-row-model";
import { useWorkspace } from "./workspace-context";

export type DiscoveryCoin = Pick<HomeCoin, "coin_type" | "presale_id" | "symbol" | "icon_url" | "lifecycle" | "verified_team">;
type Preview = Readonly<{ scope: string; coins: readonly DiscoveryCoin[] }>;
const empty: Preview = { scope: "", coins: [] };

/** Navigation changes preserve the list; changing its source, filters or page does not. */
export function discoveryScope(data: WorkspaceV1["data"], view: DataView) {
  return JSON.stringify([view, { ...data.controls[view], navigation: undefined }]);
}

/** Where an owner's last shortcuts are kept, so the collapsed rail draws them on re-entry and reload (audit 04). */
export function discoveryPreviewKey(owner: Readonly<{ kind: "guest" } | { kind: "account"; account_id: string }>) {
  return `blast.discovery-preview.${owner.kind === "account" ? owner.account_id : "guest"}`;
}

function cached(storageKey: string | undefined): Preview {
  if (!storageKey) return empty;
  try {
    const value = JSON.parse(readBrowserStorage("local", storageKey) ?? "null") as Preview | null;
    return value && typeof value.scope === "string" && Array.isArray(value.coins) ? { scope: value.scope, coins: value.coins.slice(0, 20) } : empty;
  } catch {
    return empty;
  }
}

/**
 * Only the last displayed page's identities. With `storageKey` they also outlive the workspace's
 * lifetime: the collapsed rail draws the cached marks at once instead of waiting for Discover.
 */
export function createDiscoveryPreview(storageKey?: string) {
  let current = cached(storageKey);
  const listeners = new Set<() => void>();
  function update(next: Preview) {
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    current = next;
    if (storageKey && next.coins.length) {
      writeBrowserStorage("local", storageKey, JSON.stringify(next));
    }
    for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear: () => update(empty),
    remember(scope: string, coins: readonly DiscoveryCoin[]) {
      const seen = new Set<string>();
      const identities: DiscoveryCoin[] = [];
      for (const coin of coins) {
        const canonical = canonicalCoinType(coin.coin_type);
        if (!canonical || seen.has(canonical)) continue;
        seen.add(canonical);
        identities.push({ coin_type: canonical, presale_id: coin.presale_id, symbol: coin.symbol, icon_url: coin.icon_url, lifecycle: coin.lifecycle, ...(coin.verified_team ? { verified_team: true } : {}) });
        if (identities.length === 20) break;
      }
      update({ scope, coins: identities });
    },
  };
}

export const DiscoveryPreviewContext = createContext<ReturnType<typeof createDiscoveryPreview> | null>(null);
const noSubscription = () => () => {};
const emptySnapshot = () => empty;

export function useDiscoveryPreview() {
  const registry = useContext(DiscoveryPreviewContext);
  return useSyncExternalStore(registry?.subscribe ?? noSubscription, registry?.getSnapshot ?? emptySnapshot, emptySnapshot);
}

/**
 * Retain marks on collapse, but clear when the visible list disappears for any other reason. The
 * rail (`retain`) only shows while Discover is collapsed on screen, which a width default can do
 * with the saved workspace open, so it never clears: opening Discover clears the marks itself.
 */
export function useReportDiscoveryCoins(view: "Coins" | "Presales", coins: readonly DiscoveryCoin[], enabled = true, retain = false) {
  const registry = useContext(DiscoveryPreviewContext);
  const { snapshot, dispatch } = useWorkspace();
  const getSnapshot = dispatch.getSnapshot;
  const scope = discoveryScope(snapshot.data, view);
  useLayoutEffect(() => {
    registry?.remember(scope, enabled ? coins : []);
    return () => {
      if (!retain && !getSnapshot().data.collapsed) registry?.clear();
    };
  }, [registry, scope, coins, enabled, retain, getSnapshot]);
}
