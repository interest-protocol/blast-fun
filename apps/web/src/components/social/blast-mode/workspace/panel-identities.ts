"use client";

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";

/** What a mounted panel has read about its coin, so the workspace bar can show the same mark and symbol. */
export type PanelCoinIdentity = Readonly<{ symbol: string; icon: string | null; name: string | null }>;

function key(coinType: string, network = "mainnet") {
  try {
    return `${network}:${normalizeStructTag(coinType)}`;
  } catch {
    return `${network}:${coinType}`;
  }
}

/**
 * Session-only memory of coin marks seen in this workspace. Nothing is
 * persisted: a panel that has not been shown since entry falls back to
 * `coinTypeIdentity`.
 */
export function createPanelIdentities() {
  const identities = new Map<string, PanelCoinIdentity>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    report(coinType: string, identity: PanelCoinIdentity, network = "mainnet") {
      const id = key(coinType, network);
      const previous = identities.get(id);
      if (previous && previous.symbol === identity.symbol && previous.icon === identity.icon && previous.name === identity.name) return;
      identities.set(id, identity);
      version += 1;
      for (const listener of listeners) listener();
    },
    get: (coinType: string, network = "mainnet") => identities.get(key(coinType, network)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

export type PanelIdentities = ReturnType<typeof createPanelIdentities>;

export const PanelIdentitiesContext = createContext<PanelIdentities | null>(null);

const noSubscription = () => () => {};
const noVersion = () => 0;

export function useReportPanelIdentity(coinType: string, symbol: string | undefined, icon: string | null | undefined, name: string | undefined, network = "mainnet") {
  const registry = useContext(PanelIdentitiesContext);
  useEffect(() => {
    if (registry && symbol) registry.report(coinType, { symbol, icon: icon ?? null, name: name ?? null }, network);
  }, [registry, coinType, symbol, icon, name, network]);
}

/** Re-renders when any panel reports a new identity. */
export function usePanelIdentities(): PanelIdentities | null {
  const registry = useContext(PanelIdentitiesContext);
  useSyncExternalStore(registry?.subscribe ?? noSubscription, registry?.version ?? noVersion, noVersion);
  return registry;
}

/** The address suffix disambiguates identical tickers without opening an inspector. */
export function panelIdentityLabel(panel: PanelSetup) {
  const [address, module, type] = panel.coin_type.split("::");
  return `${module}::${type} · ${address!.slice(0, 6)}…${address!.slice(-6)} · ${panel.network}`;
}

export function panelSymbol(panel: PanelSetup, identities: PanelIdentities | null) {
  return identities?.get(panel.coin_type, panel.network)?.symbol ?? coinTypeIdentity(panel.coin_type).symbol;
}

/**
 * What a coin type shows before its read lands, after a reload, or when the read fails: the
 * curated identity for an ecosystem coin (Hashi BTC is "hashiBTC", never its struct name "BTC",
 * which suiWBTC shares), else the struct name with no name or icon.
 */
export function coinTypeIdentity(coinType: string): PanelCoinIdentity {
  const core = coreCoin(coinType);
  return core ? { symbol: core.symbol, icon: core.logoUrl, name: core.name } : { symbol: coinType.split("::").at(-1) || "Asset", icon: null, name: null };
}
