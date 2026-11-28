"use client";

import { createContext, useContext, type ReactNode } from "react";

import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";

const BridgeContext = createContext(false);

/** Whether the server turned Bridge to Sui on. */
export function BridgeProvider({ enabled, children }: Readonly<{ enabled: boolean; children: ReactNode }>) {
  return <BridgeContext value={enabled}>{children}</BridgeContext>;
}

/**
 * Whether the card can work: the flag is on and Privy is mounted (source
 * wallets connect through Privy). False hides every Bridge button.
 */
export function useBridge(): boolean {
  const enabled = useContext(BridgeContext);
  const privy = usePrivySessionMounted();
  return enabled && privy;
}
