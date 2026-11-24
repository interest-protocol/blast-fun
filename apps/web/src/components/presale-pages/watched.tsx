"use client";

import { useCallback, useMemo, type ComponentProps } from "react";

import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useWatchStar, useWatchlistSnapshot } from "#web/components/social/watchlist/Watchlist.tsx";
import { fetchWatchlistPage } from "#web/components/social/watchlist/watchlist-client.ts";
import { unwrapApiResult } from "#web/lib/query/client.ts";
import type { PresaleListStatus, SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import { SOCIAL_WATCHLIST_LIMIT, WATCHLIST_PAGE_MAX, type SocialWatchlistPage } from "@blast/core/web/contracts/watchlist.ts";

import { PresalesList } from "./PresalesList";
import { SalePage } from "./SalePage";
import { inStatus } from "./watched-model";

export function WatchedSalePage(props: Omit<ComponentProps<typeof SalePage>, "watch">) {
  const presale = props.detail.presale;
  const star = useWatchStar(presale);
  return <SalePage {...props} watch={star} />;
}

export function WatchedPresalesList(props: Omit<ComponentProps<typeof PresalesList>, "watchlist">) {
  const viewer = useSocialViewer();
  const snapshot = useWatchlistSnapshot();
  const getAccessToken = viewer.getAccessToken;
  // Every star, newest first, then the tab's: pages of 50 until the list ends (at most the limit).
  const load = useCallback(async (status: PresaleListStatus) => {
    if (!getAccessToken) return null;
    const rows: SocialPresaleSummary[] = [];
    let cursor: string | null = null;
    let total = 0;
    for (let page = 0; page < Math.ceil(SOCIAL_WATCHLIST_LIMIT / WATCHLIST_PAGE_MAX); page += 1) {
      const body: SocialWatchlistPage = unwrapApiResult(await fetchWatchlistPage({ getAccessToken }, WATCHLIST_PAGE_MAX, cursor));
      total = body.total;
      rows.push(...body.items.map((item) => item.presale));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    return { rows: rows.filter((sale) => inStatus(sale, status)), total };
  }, [getAccessToken]);
  const watchlist = useMemo(
    () => ({ ids: snapshot.ids, signedIn: viewer.signedIn, load }),
    [snapshot.ids, viewer.signedIn, load],
  );
  return <PresalesList {...props} watchlist={watchlist} />;
}
