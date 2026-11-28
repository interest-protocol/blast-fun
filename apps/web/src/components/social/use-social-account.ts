"use client";

import { publicErrorMessage, PublicError, publicErrorCopy } from "#web/lib/errors.ts";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";

import {
  fetchSocialAccount,
  SOCIAL_ACCOUNT_LOADING,
  SOCIAL_ACCOUNT_ERROR,
  socialAccountFromSession,
  type SocialAccountState,
} from "./social-account-client";
import { useWalletSession } from "./WalletSession";
import { useActivePrivySession } from "./use-active-privy-session";
import { useSocialAccountSession, type SocialAccountSessionStatus } from "./use-social-account-session";

export type UseSocialAccount = SocialAccountState & Readonly<{
  /** Session provenance; absent in older injected contexts, which cannot confirm a workspace guest. */
  sessionStatus?: SocialAccountSessionStatus;
  /** Auth principal is available before me resolves; wallet hint changes keep this identity. */
  sessionIdentity?: string;
  /** Reads the account again, e.g. after editing the profile or retrying a failed creation. */
  refresh: () => void;
}>;

/**
 * The page's one shared account state. `SocialSession` (SocialSession.tsx)
 * provides it on social and presale pages, so every reader below it shares a
 * single `me` read and one `refresh` updates them all.
 */
export const SocialAccountContext = createContext<UseSocialAccount | null>(null);

/**
 * Loads the viewer's account, creating saved random defaults when absent,
 * using the Privy access token or wallet session cookie whenever the identity changes or
 * `refresh` is called. With `enabled` false it reads nothing (a shared state
 * is used instead). Without a Privy session mounted, or before its SDK loads
 * when no Privy session is expected, Privy counts as ready and signed out, so
 * a wallet session still reads `me`.
 */
export function useSocialAccountRead(enabled = true): UseSocialAccount {
  const privy = useActivePrivySession();
  const wallet = useWalletSession();
  const hydrated = useHydrated();
  const { getAccessToken, user, walletActive } = privy;
  const ready = hydrated && privy.ready;
  const authenticated = privy.authenticated;
  const identity = authenticated ? (user?.id ?? "") : walletActive ? "wallet" : "";
  const walletRefresh = wallet.refresh;
  const client = useAppQueryClient();
  const tokenSource = useRef(getAccessToken);
  useEffect(() => {
    tokenSource.current = getAccessToken;
  }, [getAccessToken]);

  const settled = socialAccountFromSession({ ready, authenticated, wallet: walletActive });
  // One `me` read per signed-in identity (a shared query, OA-38), again on `refresh`.
  const enabledRead = settled === null && enabled;
  const query = useQuery(
    {
      queryKey: queryKeys.me.account(identity),
      queryFn: async ({ signal }) => {
        const result = await fetchSocialAccount({ getAccessToken: async () => authenticated ? tokenSource.current() : null, signal });
        if (result.status === "error") throw new PublicError(publicErrorCopy(result.code, "Your account could not load. Try again."), result);
        return result;
      },
      // One answer per ask: a failed read clears through the client's outage recheck (`recheckFailed`), not a retry ladder.
      retry: false,
      enabled: enabledRead,
      // The account changes only by this viewer's own actions, which call `refresh`.
      staleTime: Number.POSITIVE_INFINITY,
    },
    client,
  );
  const fetched = enabledRead ? query.data : undefined;
  // Retain the read's provenance even when a refused wallet response clears its hint.
  const state = settled ?? fetched ?? (query.isError ? SOCIAL_ACCOUNT_ERROR : SOCIAL_ACCOUNT_LOADING);
  const { sessionStatus, resetRefusal } = useSocialAccountSession({ ready, authenticated, wallet: walletActive, accountState: state });
  const refresh = useCallback(() => {
    resetRefusal();
    void client.invalidateQueries({ queryKey: queryKeys.me.account(identity), exact: true });
  }, [client, identity, resetRefusal]);

  // A wallet session `me` refused has had its cookies cleared: re-read the hint.
  const refusedAt = fetched?.status === "signed_out" ? query.dataUpdatedAt : 0;
  useEffect(() => {
    if (refusedAt !== 0) walletRefresh();
  }, [refusedAt, walletRefresh]);

  // A refresh keeps the same user's last answer until the new one arrives, so
  // the shell and the page do not fall back to loading in between.
  return { status: state.status, account: state.account, sessionStatus, sessionIdentity: identity, ...(state.status === "error" ? { message: fetched?.message ?? publicErrorMessage(query.error, "Your account could not load. Try again.") } : {}), refresh };
}

/**
 * The caller's Blast Account for social pages: `{ status, account, refresh }`
 * (statuses in `social-account-client.ts`). Below a `SocialSession` it is the
 * page's shared state; elsewhere it reads `me` itself.
 */
export function useSocialAccount(): UseSocialAccount {
  const shared = useContext(SocialAccountContext);
  const own = useSocialAccountRead(shared === null);
  return shared ?? own;
}
