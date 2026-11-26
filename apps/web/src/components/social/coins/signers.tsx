"use client";

import { useEffect, useRef } from "react";

import { usePrivySession } from "#web/components/auth/privy-session.ts";

import { findEmbeddedSuiWallet } from "#web/components/mission-control/privy-embedded-wallet.ts";

import type { WithdrawSigner } from "./withdraw-flow";

/** The key-format code (Privy's Sui signer), loaded at the first signature, not with the page. */
const loadPrivyKey = () => import("#web/components/mission-control/privy-sui-wallet.ts");

/** What the coins sheet needs from Privy: the embedded Sui wallet, creating it on demand, and signing with it. */
export type PrivyCoinSigner = Readonly<{
  /** The signed-in user's embedded Sui address, or null without one. */
  address(): string | null;
  /** Creates the embedded Sui wallet (Sui is an extended chain: Privy never creates it at login). */
  createWallet(): Promise<void>;
  /** The sponsored-withdraw signer for the embedded wallet. */
  signer(): WithdrawSigner | null;
}>;

/**
 * Registers the Privy signer while it is mounted, under a Privy session
 * provider (`usePrivySessionMounted`). It signs once the session's SDK has
 * started, which a Privy sign-in always has.
 */
export function PrivyCoinSignerBridge({ onChange }: Readonly<{ onChange: (signer: PrivyCoinSigner | null) => void }>) {
  const { runtime } = usePrivySession();
  const latest = useRef(runtime);
  useEffect(() => {
    latest.current = runtime;
  });
  useEffect(() => {
    const embedded = () => (latest.current?.authenticated ? findEmbeddedSuiWallet(latest.current.user) : null);
    const started = () => {
      if (!latest.current) throw new Error("Privy did not start. Try again.");
      return latest.current;
    };
    onChange({
      address: () => embedded()?.address ?? null,
      async createWallet() {
        await started().createWallet({ chainType: "sui" });
      },
      signer() {
        const wallet = embedded();
        if (!wallet) return null;
        return {
          fee: "sponsored",
          address: wallet.address,
          async signTransaction(bytes) {
            const { privySuiSigner } = await loadPrivyKey();
            const key = privySuiSigner(wallet, (input) => started().signRawHash(input));
            return (await key.signTransaction(bytes)).signature;
          },
        };
      },
    });
    return () => onChange(null);
  }, [onChange]);
  return null;
}
