"use client";

import { useCallback, useEffect, type ReactNode } from "react";

import { usePrivySession, type PrivySession } from "#web/components/auth/privy-session.ts";
import { useRestorePrivyWallet } from "#web/components/auth/privy-wallet-picker.ts";
import type { ActivitySession } from "#web/components/analytics/account-activity.ts";
import { AccountActivity } from "#web/components/analytics/AccountActivity.tsx";
import { isAccountActivityEnabled } from "#web/components/analytics/activity-enabled.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import {
  refreshSocialXHandle,
  socialViewerProps,
} from "./social-account-client";

import { SocialViewerProvider } from "./SignInGate";
import {
  SocialAccountContext,
  useSocialAccountRead,
} from "./use-social-account";
import { useWalletSession, WalletSessionProvider } from "./WalletSession";

/**
 * The social layer of a launch page, inside the Privy session (the presale
 * provider root's `WalletProvider`). The viewer of every sign-in gate below
 * it is signed in through either session (OA-16): Privy (X, Google, EVM and
 * Solana wallets; its access token goes as Bearer) or a Sui wallet session
 * (Slush; its HttpOnly cookie goes on same-origin calls). Its callsign comes
 * from `me`; signing out ends both sessions. It shares one `me` read with
 * every `useSocialAccount` below it. New accounts get saved random identities
 * during that load; the sign-in sheet lives in the app shell (`SocialShell`).
 */
export function SocialSession({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <WalletSessionProvider>
      <SocialSessionViewer>{children}</SocialSessionViewer>
    </WalletSessionProvider>
  );
}

function SocialSessionViewer({ children }: Readonly<{ children: ReactNode }>) {
  const privy = usePrivySession();
  useRestorePrivyWallet(privy.ready && privy.authenticated ? privy.user?.wallet : undefined);
  const wallet = useWalletSession();
  const account = useSocialAccountRead();
  const client = useAppQueryClient();
  const privyId = privy.ready && privy.authenticated ? privy.user?.id : null;
  const { getAccessToken } = privy;
  useEffect(() => {
    if (!privyId) return;
    const controller = new AbortController();
    void refreshSocialXHandle({
      getAccessToken,
      signal: controller.signal,
    }).then(async (updated) => {
      if (!updated || controller.signal.aborted) return;
      // Discard a pre-refresh me read before requesting the updated identity.
      await client.cancelQueries({ queryKey: queryKeys.me.account() });
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.me.account() }),
        client.invalidateQueries({ queryKey: queryKeys.profiles.all }),
      ]);
    });
    return () => controller.abort();
  }, [privyId, getAccessToken, client]);
  const { end } = wallet;
  const { logout: privyLogout } = privy;
  const logout = useCallback(async () => {
    await end();
    await privyLogout();
  }, [end, privyLogout]);
  const activityEnabled = isAccountActivityEnabled();
  const activitySession = activityEnabled
    ? settledActivitySession(account, privy, wallet.active)
    : null;
  return (
    <SocialAccountContext value={account}>
      <SocialViewerProvider
        sessionIdentity={account.sessionIdentity}
        accountId={account.account?.account_id ?? null}
        {...socialViewerProps({ ...privy, logout }, account, wallet.active)}
      >
        {activityEnabled && <AccountActivity session={activitySession} />}
        {children}
      </SocialViewerProvider>
    </SocialAccountContext>
  );
}

function settledActivitySession(
  account: ReturnType<typeof useSocialAccountRead>,
  privy: PrivySession,
  walletActive: boolean,
): ActivitySession | null {
  if (
    account.status !== "ready" ||
    !account.account ||
    account.sessionStatus !== "authenticated"
  ) {
    return null;
  }
  const accountId = account.account.account_id;
  const privyId = privy.ready && privy.authenticated ? privy.user?.id : null;
  if (
    privy.ready &&
    privy.authenticated &&
    privyId &&
    account.sessionIdentity === privyId
  ) {
    return {
      accountId,
      identity: privyId,
      mode: "privy",
      getAccessToken: privy.getAccessToken,
    };
  }
  if (
    account.sessionIdentity === "wallet" &&
    walletActive &&
    !privy.authenticated
  ) {
    return { accountId, identity: "wallet", mode: "wallet" };
  }
  return null;
}
