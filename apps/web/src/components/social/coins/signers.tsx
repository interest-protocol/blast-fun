"use client";

import { useLayoutEffect, useRef } from "react";

import { startPrivy, usePrivySession } from "#web/components/auth/privy-session.ts";

import { findEmbeddedSuiWallet } from "#web/components/mission-control/privy-embedded-wallet.ts";

import { accountSwitchSignal } from "../account-selection";
import { useSocialViewer } from "../SignInGate";
import { useWalletSession } from "../WalletSession";
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
 * provider (`usePrivySessionMounted`). Its actions wait for the session's
 * SDK, which may still be starting on a restored session, and fail only if
 * Privy does not start.
 */
export function PrivyCoinSignerBridge({ onChange }: Readonly<{ onChange: (signer: PrivyCoinSigner | null) => void }>) {
  const session = usePrivySession();
  const { load } = session;
  const { selection } = useWalletSession();
  const { sessionIdentity } = useSocialViewer();
  const active = selection !== "wallet" && sessionIdentity !== "wallet";
  const runtime = active ? session.runtime : null;
  const latest = useRef(runtime);
  useLayoutEffect(() => {
    latest.current = runtime;
  });
  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    let registered = true;
    const isActive = () => registered && !accountSwitchSignal.aborted;
    const embedded = () => (isActive() && latest.current?.authenticated ? findEmbeddedSuiWallet(latest.current.user) : null);
    function signingRuntime(address: string) {
      const current = latest.current;
      if (!current || embedded()?.address !== address) throw new Error("The active account changed.");
      return current;
    }
    onChange({
      address: () => embedded()?.address ?? null,
      async createWallet() {
        if (!isActive()) throw new Error("The active account changed.");
        const current = latest.current ?? await startPrivy(load);
        if (!isActive()) throw new Error("The active account changed.");
        await current.createWallet({ chainType: "sui" });
      },
      signer() {
        const wallet = embedded();
        if (!wallet) return null;
        return {
          fee: "sponsored",
          address: wallet.address,
          async signTransaction(bytes) {
            const { privySuiSigner } = await loadPrivyKey();
            const key = privySuiSigner(wallet, (input) => signingRuntime(wallet.address).signRawHash(input));
            const { signature } = await key.signTransaction(bytes);
            signingRuntime(wallet.address);
            return signature;
          },
        };
      },
    });
    return () => {
      registered = false;
      onChange(null);
    };
  }, [active, load, onChange]);
  return null;
}
