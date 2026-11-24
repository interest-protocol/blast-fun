"use client";

import { useCallback, useState } from "react";
import type { SocialAccountState } from "./social-account-client";

export type SocialAccountSessionStatus =
  | "pending"
  | "signed_out"
  | "authenticated"
  | "refused";

function sessionStatusFor(
  ready: boolean,
  hasIdentity: boolean,
  refused: boolean,
): SocialAccountSessionStatus {
  if (!ready) return "pending";
  if (refused) return "refused";
  return hasIdentity ? "authenticated" : "signed_out";
}

/** Keeps a refused read distinct from the no-session state after its wallet hint clears. */
export function useSocialAccountSession({
  ready,
  authenticated,
  wallet,
  accountState,
}: Readonly<{
  ready: boolean;
  authenticated: boolean;
  wallet: boolean;
  accountState: SocialAccountState;
}>) {
  const [refused, setRefused] = useState(false);
  const hasIdentity = authenticated || wallet;
  const refusedNow =
    ready && hasIdentity && accountState.status === "signed_out";
  const resolved = accountState.status === "ready";
  // Remember the read before a wallet hint update can commit a no-session render.
  // This is historical refusal evidence, cleared by success or intentional retry.
  const retainRefusal = refusedNow || (refused && !resolved);
  if (retainRefusal !== refused) setRefused(retainRefusal);
  const resetRefusal = useCallback(() => setRefused(false), []);
  const sessionStatus = sessionStatusFor(ready, hasIdentity, retainRefusal);
  return { sessionStatus, resetRefusal };
}
