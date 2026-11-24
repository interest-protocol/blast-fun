"use client";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { UseSocialAccount } from "../../../src/components/social/use-social-account.ts";
import type { SponsoredSigner } from "../../../src/components/social/sponsored-transaction.ts";
import type { PrivyCoinSigner } from "../../../src/components/social/coins/signers.tsx";

const SignerContext = createContext<(() => SponsoredSigner | null) | null>(null);
export function FixtureSignerScope({ signer, children }: Readonly<{ signer: () => SponsoredSigner | null; children: ReactNode }>) {
  return <SignerContext value={signer}>{children}</SignerContext>;
}

/** Acceptance fixtures drive SocialViewer explicitly and never mount an authentication or signing client. */
export function usePrivySessionMounted() { return useContext(SignerContext) !== null; }
export function PrivySessionProvider({ children }: { children: ReactNode }) { return children; }
export function PrivyCoinSignerBridge({ onChange }: Readonly<{ onChange: (signer: PrivyCoinSigner | null) => void }>) {
  const signer = useContext(SignerContext);
  useEffect(() => {
    if (!signer) throw new Error("Signing is unavailable in this acceptance fixture");
    onChange({ address: () => signer()?.address ?? null, createWallet: async () => undefined, signer });
    return () => onChange(null);
  }, [signer, onChange]);
  return null;
}

const guest: UseSocialAccount = { status: "signed_out", account: null, sessionStatus: "signed_out", sessionIdentity: "", refresh: () => undefined };
export const SocialAccountContext = createContext<UseSocialAccount | null>(null);
export function useSocialAccountRead() { return guest; }
export function useSocialAccount() { return useContext(SocialAccountContext) ?? guest; }
