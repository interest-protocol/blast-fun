import { useCallback } from "react";

import { usePrivySession } from "#web/components/auth/privy-session.ts";

import { useWalletSession } from "./WalletSession";

/** Keep Privy signed in while the social account uses the direct wallet session. */
export function useActivePrivySession() {
  const privy = usePrivySession();
  const wallet = useWalletSession();
  const useWallet = wallet.selection === "wallet";
  const { getAccessToken: accessToken } = privy;
  const getAccessToken = useCallback(() => requirePrivyAccessToken(accessToken), [accessToken]);

  return {
    ...privy,
    ready: privy.ready || useWallet,
    authenticated: privy.authenticated && !useWallet,
    walletActive: wallet.active && wallet.selection !== "privy",
    getAccessToken,
  };
}

export async function requirePrivyAccessToken(getAccessToken: () => Promise<string | null>): Promise<string> {
  const token = await getAccessToken();
  if (!token) {
    // A missing Privy token must never send the other account's wallet cookie as authentication.
    throw new Error("Privy access token unavailable");
  }
  return token;
}
