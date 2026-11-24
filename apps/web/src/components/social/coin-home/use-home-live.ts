"use client";

import { useEffect, useEffectEvent } from "react";

import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { HOME_RECENT_BUY_MS, type HomeQuery, type HomeRecentBuy } from "@blast/core/web/contracts/home.ts";

import { liveFreshness, recordHintPainted } from "../home/activity-hints";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, type FeedFreshnessSource, type FreshnessHint } from "../home/feed-freshness";
import { discoverQuery } from "./home-client";

/** Visible Home reads share query keys, cached answers and in-flight requests with manual refresh. */
export function useHomeLive(
  query: HomeQuery,
  enabled: boolean,
  source: FeedFreshnessSource | undefined,
  onBuys: (buys: readonly HomeRecentBuy[]) => void,
): void {
  const client = useAppQueryClient();
  const key = JSON.stringify(query);
  const reportBuys = useEffectEvent(onBuys);
  useEffect(() => {
    if (!enabled) return;
    const freshness = source ?? liveFreshness("home");
    let disposed = false;
    let visibleSince = Date.now();
    const discover = discoverQuery(query, true);
    const seen = new Map<string, number>();
    const look = (hint?: FreshnessHint) => {
      if (document.visibilityState !== "visible" || !gate.admit(hint)) return;
      const read = client.fetchQuery({ ...discover, staleTime: 0 }).catch(() => undefined);
      void read.then(page => {
        if (disposed || document.visibilityState !== "visible") return;
        const floor = Math.max(visibleSince, Date.now() - HOME_RECENT_BUY_MS);
        for (const [id, at] of seen) {
          if (at <= floor) seen.delete(id);
        }
        const buys = page?.recent_buys?.filter(buy => {
          if (buy.occurred_at_ms <= floor || seen.has(buy.activity_id)) return false;
          seen.set(buy.activity_id, buy.occurred_at_ms);
          return true;
        });
        if (buys?.length) reportBuys(buys);
      });
      void Promise.all([read, invalidateAfter(client, { kind: "home-live" })]).then(() => {
        if (!disposed) recordHintPainted("home", hint);
      });
    };
    const gate = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), look);
    const off = freshness.subscribe(look);
    const onVisibility = () => { visibleSince = Date.now(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      off();
      gate.cancel();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `key` stands for `query`: a query with the same text is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, key, source]);
}
