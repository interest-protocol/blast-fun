"use client";

import { useEffect } from "react";

import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { HomeQuery } from "@blast/core/web/contracts/home.ts";

import { liveFreshness, recordHintPainted } from "../home/activity-hints";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, type FeedFreshnessSource, type FreshnessHint } from "../home/feed-freshness";
import { discoverQuery } from "./home-client";

/** Visible Home reads share query keys, cached answers and in-flight requests with manual refresh. */
export function useHomeLive(query: HomeQuery, enabled: boolean, source?: FeedFreshnessSource): void {
  const client = useAppQueryClient();
  const key = JSON.stringify(query);
  useEffect(() => {
    if (!enabled) return;
    const freshness = source ?? liveFreshness("home");
    let disposed = false;
    const look = (hint?: FreshnessHint) => {
      if (document.visibilityState !== "visible" || !gate.admit(hint)) return;
      void Promise.all([
        client.fetchQuery({ ...discoverQuery(query, true), staleTime: 0 }).catch(() => undefined),
        invalidateAfter(client, { kind: "home-live" }),
      ]).then(() => { if (!disposed) recordHintPainted("home", hint); });
    };
    const gate = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), look);
    const off = freshness.subscribe(look);
    return () => {
      disposed = true;
      off();
      gate.cancel();
    };
    // `key` stands for `query`: a query with the same text is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, key, source]);
}
