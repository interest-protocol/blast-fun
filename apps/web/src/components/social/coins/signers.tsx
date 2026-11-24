"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";

import { useEffect, useRef } from "react";

import { findEmbeddedSuiWallet, privySuiSigner } from "#web/components/mission-control/privy-sui-wallet.ts";

import type { WithdrawSigner } from "./withdraw-flow";

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
 * Registers the Privy signer while it is mounted. It is rendered only under a
 * Privy session provider (`usePrivySessionMounted`): Privy's wallet hooks
 * throw without one.
 */
export function PrivyCoinSignerBridge({ onChange }: Readonly<{ onChange: (signer: PrivyCoinSigner | null) => void }>) {
  const privy = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const latest = useRef({ privy, createWallet, signRawHash });
  useEffect(() => {
    latest.current = { privy, createWallet, signRawHash };
  });
  useEffect(() => {
    const embedded = () => (latest.current.privy.authenticated ? findEmbeddedSuiWallet(latest.current.privy.user) : null);
    onChange({
      address: () => embedded()?.address ?? null,
      async createWallet() {
        await latest.current.createWallet({ chainType: "sui" });
      },
      signer() {
        const wallet = embedded();
        if (!wallet) return null;
        const key = privySuiSigner(wallet, (input) => latest.current.signRawHash(input));
        return {
          fee: "sponsored",
          address: wallet.address,
          async signTransaction(bytes) {
            return (await key.signTransaction(bytes)).signature;
          },
        };
      },
    });
    return () => onChange(null);
  }, [onChange]);
  return null;
}
