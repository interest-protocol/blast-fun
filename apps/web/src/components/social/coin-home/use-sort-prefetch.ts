"use client";

import { useEffect } from "react";

import { PUBLIC_STALE_MS } from "#web/lib/query/client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { HomeQuery } from "@blast/core/web/contracts/home.ts";

import { discoverQuery } from "./home-client";
import { HOME_TABS, type HomeTab } from "./home-state";

/**
 * A cached view older than the public freshness limit is shown at once and
 * refreshed behind it.
 */
export function useSortPrefetch(query: HomeQuery): void {
  const client = useAppQueryClient();
  const key = JSON.stringify(query);
  useEffect(() => {
    const shown = discoverQuery(query, true);
    const state = client.getQueryState(shown.queryKey);
    if (state?.data !== undefined && state.dataUpdatedAt < Date.now() - PUBLIC_STALE_MS)
      void client.fetchQuery({ ...shown, staleTime: PUBLIC_STALE_MS }).catch(() => undefined);
    // `key` stands for `query`: a query with the same text is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
}

/**
 * Home reads only the tab on screen. Another tab's first page is fetched when
 * a pointer rests on it, a finger lands on it or the keyboard focuses it, so
 * the switch usually paints from the cache; until then the previous rows hold
 * their place. Each read is the same public URL for every reader, so the CDN
 * answers most of them (`s-maxage=10`). A header sort is not prefetched: it is
 * one request when pressed.
 */
export function useTabPrefetch(query: HomeQuery): (tab: HomeTab) => void {
  const client = useAppQueryClient();
  return (tab) => {
    const { stage, sort } = HOME_TABS[tab];
    void client.prefetchQuery(discoverQuery({ ...query, stage, sort, page: 1, cursor: null }, true));
  };
}
