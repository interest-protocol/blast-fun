"use client";

import { createContext, useContext, type ReactNode } from "react";

import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";

import type { BridgeConfig } from "./bridge-config.ts";

const BridgeContext = createContext<BridgeConfig | null>(null);

/** The server's validated Bridge to Sui settings, or null while the flag is off. */
export function BridgeProvider({ config, children }: Readonly<{ config: BridgeConfig | null; children: ReactNode }>) {
  return <BridgeContext value={config}>{children}</BridgeContext>;
}

/**
 * The bridge settings when the card can work: the flag is on and Privy is
 * mounted (source wallets connect through Privy). Null hides every Bridge button.
 */
export function useBridge(): BridgeConfig | null {
  const config = useContext(BridgeContext);
  const privy = usePrivySessionMounted();
  return privy ? config : null;
}
