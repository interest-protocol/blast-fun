"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { SOCIAL_FOLLOWING_WALLETS_PATH, socialFollowingWalletsSchema, type SocialBuyAlert } from "@blast/core/modules/social/contracts/buy-alerts.ts";
import { FollowedBuyAlert } from "#web/components/blast-ui/FollowedBuyAlert.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { presaleHref } from "../feed-ui/shell-bridge-model";
import { activityHints, tabActivityHints } from "../home/activity-hints";
import { callSocialApi, type TokenSource } from "../social-api";
import { FollowedBuys, followedBuyOf, readBuyAlertCard } from "./followed-buys";

/** The followed wallets are read once and stay fresh this long; a follow or unfollow here reads them again. */
export const FOLLOWING_WALLETS_STALE_MS = 10 * 60_000;
const SURFACE = "followed-buys";

/** The card's coin link: the sale's page, or a curve coin's own page. */
export function buyAlertCoinHref(coin: SocialBuyAlert["coin"]): string {
  return coin.presale_id === null ? coinPagePath(coin.coin_type) : presaleHref(coin.presale_id);
}

/**
 * The shell's followed buy host, mounted once for a signed-in viewer with an
 * account. Off when the device's "Buy alerts from people you follow" switch
 * is off, and while the viewer follows nobody with a named wallet (no hint
 * subscription then).
 */
export function FollowedBuyAlerts({ accountId, ownWallets, getAccessToken }: Readonly<{
  accountId: string;
  ownWallets: readonly string[];
  getAccessToken: TokenSource;
}>) {
  const { buyAlerts } = useDevicePrefs();
  const client = useAppQueryClient();
  const wallets = useQuery({
    queryKey: queryKeys.me.followingWallets(accountId),
    queryFn: async ({ signal }) => {
      const result = await callSocialApi({ getAccessToken, signal }, SOCIAL_FOLLOWING_WALLETS_PATH, { method: "GET" }, socialFollowingWalletsSchema);
      if (result.status !== "ok") throw new Error(result.code ?? "following_wallets_unavailable");
      return result.body.wallets;
    },
    enabled: buyAlerts,
    staleTime: FOLLOWING_WALLETS_STALE_MS,
    refetchOnWindowFocus: false,
  }, client);
  const followed = useMemo(() => new Set(wallets.data ?? []), [wallets.data]);
  const own = useMemo(() => new Set(ownWallets), [ownWallets]);
  const [shown, setShown] = useState<SocialBuyAlert | null>(null);

  useEffect(() => {
    if (!buyAlerts || followed.size === 0) return undefined;
    const hints = tabActivityHints();
    if (hints === null) return undefined;
    const buys = new FollowedBuys({
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      random: Math.random,
      visible: () => document.visibilityState !== "hidden",
      readCard: (id) => readBuyAlertCard(id),
      show: setShown,
    });
    const off = activityHints(SURFACE, hints, (hint) => followedBuyOf(hint, followed, own) !== null).subscribe((hint) => {
      const buy = hint && followedBuyOf(hint, followed, own);
      if (buy) buys.offer(buy);
    });
    return () => {
      off();
      buys.close();
    };
  }, [buyAlerts, followed, own]);

  const close = useCallback(() => setShown(null), []);
  if (!buyAlerts) return null;
  // The polite region stays mounted while alerts are on, so screen readers announce each card added to it.
  // A newer buy replaces the card: a new key mounts it fresh.
  return (
    <div aria-label="Buys from people you follow" aria-live="polite" role="status">
      {shown === null ? null : <FollowedBuyAlert alert={shown} coinHref={buyAlertCoinHref(shown.coin)} key={shown.activity_id} onClose={close} />}
    </div>
  );
}
