"use client";

import { useEffect, useEffectEvent } from "react";

import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { HOME_RECENT_BUY_MS, type HomeQuery } from "@blast/core/web/contracts/home.ts";

import { liveFreshness, recordHintPainted } from "../home/activity-hints";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, NEW_POSTS_POLL_MS, type FeedFreshnessSource, type FreshnessHint } from "../home/feed-freshness";
import { discoverQuery } from "./home-client";
import { hintBuy, homeHintReads, type HomeCueBuy } from "./home-model";

/** Priced buy hints are collected this long, then the cue shows the biggest. */
export const HOME_HINT_CUE_COLLECT_MS = 250;

/** How many reported buy ids a mounted Home list remembers. */
const HOME_SEEN_BUYS = 1_024;

/** Home's hint source: a priced buy hint goes to the cue only and makes no read (`homeHintReads`). */
export function homeFreshness(): FeedFreshnessSource {
  return liveFreshness("home", NEW_POSTS_POLL_MS, homeHintReads);
}

/**
 * Visible Home reads share query keys, cached answers and in-flight requests with manual refresh.
 *
 * `onBuys` gets new buys for the cue from two paths that share one `seen` set of activity ids:
 * a priced buy hint, collected for `HOME_HINT_CUE_COLLECT_MS` (no read), and any other hint's
 * rate-limited re-read (its `recent_buys`). A buy reported once, shown or dropped, is never
 * reported again by either path.
 */
export function useHomeLive(
  query: HomeQuery,
  enabled: boolean,
  source?: FeedFreshnessSource,
  onBuys?: (buys: readonly HomeCueBuy[]) => void,
  refreshRelated?: () => Promise<unknown>,
): void {
  const client = useAppQueryClient();
  const key = JSON.stringify(query);
  const reportBuys = useEffectEvent((buys: readonly HomeCueBuy[]) => onBuys?.(buys));
  const refresh = useEffectEvent(() => refreshRelated?.());
  const trackBuys = onBuys !== undefined;
  useEffect(() => {
    if (!enabled) return;
    const freshness = source ?? homeFreshness();
    let disposed = false;
    let visibleSince = Date.now();
    let nextRelatedReadAt = 0;
    const discover = discoverQuery(query, true);
    // Activity ids (the row cursor) already reported, from a hint or a read. Kept by id for the mounted
    // session, not by time: a hint's time is the browser's clock and a read's is the server's, so no clock
    // skew or cached read can repeat a cue. Bounded, oldest first.
    const seen = new Set<string>();
    const remember = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > HOME_SEEN_BUYS) seen.delete(seen.values().next().value as string);
      return true;
    };
    const look = (hint?: FreshnessHint) => {
      if (document.visibilityState !== "visible") return;
      // The stream's first connect right after load would repeat the page's own read:
      // a page younger than the poll is current. A reconnect may have missed hints, so it reads.
      if (hint?.cause === "connect" && !hint.reconnect && Date.now() - (client.getQueryState(discover.queryKey)?.dataUpdatedAt ?? 0) < NEW_POSTS_POLL_MS) return;
      if (!gate.admit(hint)) return;
      const read = client.fetchQuery({ ...discover, staleTime: 0 }).catch(() => undefined);
      if (trackBuys) void read.then(page => {
        if (disposed || document.visibilityState !== "visible") return;
        const floor = Math.max(visibleSince, Date.now() - HOME_RECENT_BUY_MS);
        const buys = page?.recent_buys?.filter(buy => buy.occurred_at_ms > floor && remember(buy.activity_id));
        if (buys?.length) reportBuys(buys);
      });
      let related: Promise<unknown> | undefined;
      const now = Date.now();
      if (now >= nextRelatedReadAt) {
        nextRelatedReadAt = now + NEW_POSTS_POLL_MS;
        related = refresh();
      }
      void Promise.all([read, invalidateAfter(client, { kind: "home-live" }), related]).then(() => {
        if (!disposed) recordHintPainted("home", hint);
      });
    };
    const gate = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), look);
    const off = freshness.subscribe(look);
    // A priced buy hint, raw (before the 1 s coalescer, so none in a burst is lost): the cue only, no read.
    let collected: HomeCueBuy[] = [];
    let flush: number | undefined;
    const offHints = trackBuys ? freshness.hints?.((hint) => {
      if (disposed || document.visibilityState !== "visible") return;
      const buy = hintBuy(hint);
      if (!buy) return;
      if (!remember(buy.activity_id)) return;
      collected.push(buy);
      if (flush === undefined) flush = window.setTimeout(() => {
        flush = undefined;
        const buys = collected;
        collected = [];
        if (!disposed && document.visibilityState === "visible") reportBuys(buys);
      }, HOME_HINT_CUE_COLLECT_MS);
    }) : undefined;
    const onVisibility = () => { visibleSince = Date.now(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      off();
      offHints?.();
      window.clearTimeout(flush);
      gate.cancel();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `key` stands for `query`: a query with the same text is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, key, source, trackBuys]);
}
