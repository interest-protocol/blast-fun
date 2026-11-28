import { useCallback } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";

import { usePrivySession, type PrivySession } from "#web/components/auth/privy-session.ts";
import { rememberedWalletName } from "#web/components/sign-in/wallet-sign-in-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { resolveDefaultSuiName } from "#web/lib/sui-address-input.ts";

import type { AccountSession } from "./account-selection";
import { useSocialViewer } from "./SignInGate";
import { requirePrivyAccessToken } from "./use-active-privy-session";
import { walletIdentityScope } from "./queries";
import { useWalletSession } from "./WalletSession";

export const walletCookie = async () => null;

export function signInMethodName(user: PrivySession["user"]): string {
  const names = { twitter_oauth: "X", google_oauth: "Google", email: "Email" } as const;
  let name = user?.twitter ? names.twitter_oauth : user?.google ? names.google_oauth : user?.email ? names.email : "Blast account";
  let latest = 0;
  for (const account of user?.linkedAccounts ?? []) {
    const method = account.type === "twitter_oauth" || account.type === "google_oauth" || account.type === "email" ? names[account.type] : null;
    const verified = account.latestVerifiedAt?.getTime() ?? 0;
    if (method && verified > latest) {
      name = method;
      latest = verified;
    }
  }
  return name;
}

export function walletSessionName(address?: string | null): string {
  return (address && rememberedWalletName(address)) || "Sui wallet";
}

export function useWalletSuiName(address?: string | null) {
  return useQuery({
    queryKey: queryKeys.suiName(address ?? null),
    queryFn: address ? () => resolveDefaultSuiName(address) : skipToken,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  }, useAppQueryClient()).data ?? null;
}

/** Keep the two credentials explicit. A missing OAuth token cannot fall back to the wallet cookie. */
export function useAccountWallets() {
  const viewer = useSocialViewer();
  const privy = usePrivySession();
  const wallet = useWalletSession();
  const requireToken = useCallback(() => requirePrivyAccessToken(privy.getAccessToken), [privy.getAccessToken]);
  const activeSession: AccountSession = viewer.sessionIdentity === "wallet" ? "wallet" : "privy";
  const otherSession: AccountSession = activeSession === "wallet" ? "privy" : "wallet";
  return {
    activeSession,
    activeScope: walletIdentityScope(viewer),
    activeToken: viewer.getAccessToken ?? walletCookie,
    otherSession,
    otherScope: walletIdentityScope({ sessionIdentity: otherSession === "privy" ? privy.user?.id : "wallet", callsign: null }),
    otherToken: otherSession === "privy" ? requireToken : walletCookie,
    hasOther: viewer.signedIn && !viewer.sessionPending && (otherSession === "privy" ? privy.authenticated : wallet.active),
    oauthName: signInMethodName(privy.user),
  };
}
