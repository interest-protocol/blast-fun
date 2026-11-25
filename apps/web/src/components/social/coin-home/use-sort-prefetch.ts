"use client";

import { useEffect } from "react";

import { PUBLIC_STALE_MS } from "#web/lib/query/client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { HomeQuery } from "@blast/core/web/contracts/home.ts";

import { discoverQuery } from "./home-client";
import { HOME_TAB_KEYS, HOME_TABS } from "./home-state";

/**
 * Makes a tab switch instant. Once the visible list has loaded, the first
 * page of every other tab (same window and filters) is fetched while the
 * browser is idle, so the switch paints from the cache. A cached view older
 * than the public freshness limit is shown at once and refreshed behind it.
 * Each prefetch is the same public URL for every reader, so the CDN answers
 * most of them (`s-maxage=10`), and the server builds a window's tabs from
 * two shared reads (the whole list, and Almost graduated's few curves). A
 * header sort is not prefetched: it is one request when pressed.
 */
export function useSortPrefetch(query: HomeQuery, loaded: boolean): void {
  const client = useAppQueryClient();
  const key = JSON.stringify(query);
  useEffect(() => {
    const shown = discoverQuery(query, true);
    const state = client.getQueryState(shown.queryKey);
    if (state?.data !== undefined && state.dataUpdatedAt < Date.now() - PUBLIC_STALE_MS)
      void client.fetchQuery({ ...shown, staleTime: PUBLIC_STALE_MS }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  useEffect(() => {
    if (!loaded || query.page !== 1 || query.cursor !== null) return;
    const prefetch = () => {
      for (const key of HOME_TAB_KEYS) {
        const { stage, sort } = HOME_TABS[key];
        if (stage !== query.stage || sort !== query.sort) void client.prefetchQuery(discoverQuery({ ...query, stage, sort }, true));
      }
    };
    // A tab opened in the background prefetches once it is shown.
    let cancel = () => {};
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", schedule);
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(prefetch, { timeout: 2_000 });
        cancel = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(prefetch, 500);
        cancel = () => window.clearTimeout(id);
      }
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      document.removeEventListener("visibilitychange", schedule);
      cancel();
    };
    // `key` stands for `query`: a query with the same text is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, loaded]);
}
