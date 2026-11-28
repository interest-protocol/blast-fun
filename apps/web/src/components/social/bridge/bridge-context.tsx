"use client";

import { createContext, useContext, type ReactNode } from "react";

import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";

const BridgeContext = createContext<"off" | "blink" | "fast-fallback">("off");

/** Whether the server turned Bridge to Sui on, and with every Mayan route or Blink only. */
export function BridgeProvider({ enabled, fastMctp, children }: Readonly<{ enabled: boolean; fastMctp: boolean; children: ReactNode }>) {
  const configured = fastMctp ? "fast-fallback" : "blink";
  return <BridgeContext value={enabled ? configured : "off"}>{children}</BridgeContext>;
}

/**
 * Whether the card can work: the flag is on and Privy is mounted (source
 * wallets connect through Privy). False hides every Bridge button.
 */
export function useBridge(): boolean {
  const enabled = useContext(BridgeContext) !== "off";
  const privy = usePrivySessionMounted();
  return enabled && privy;
}

/** Every route, not Blink alone: the MCTP routes too, with the safety check before a send. */
export function useBridgeFastMctp(): boolean {
  return useContext(BridgeContext) === "fast-fallback";
}
