"use client";

import { useEffect, useEffectEvent, useRef } from "react";

import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { HOME_RECENT_BUY_MS, type HomeQuery } from "@blast/core/web/contracts/home.ts";

import { liveFreshness, recordHintPainted } from "../home/activity-hints";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, NEW_POSTS_POLL_MS, type FeedFreshnessSource, type FreshnessHint } from "../home/feed-freshness";
import { discoverQuery } from "./home-client";
import { hintTrade, homeHintReads, type HomeCueTrade } from "./home-model";

/** Priced trade hints are collected this long, then their pops land together (one render per batch). */
export const HOME_HINT_CUE_COLLECT_MS = 250;

/** How many reported trade ids a mounted Home list remembers. */
const HOME_SEEN_TRADES = 1_024;

/** Home's hint source: a priced trade hint goes to its pop only and makes no read (`homeHintReads`). */
export function homeFreshness(): FeedFreshnessSource {
  return liveFreshness("home", NEW_POSTS_POLL_MS, homeHintReads);
}

/**
 * Visible Home reads share query keys, cached answers and in-flight requests with manual refresh.
 *
 * `onTrades` gets new trades for the pops from two paths that share one `seen` set of activity ids:
 * a priced buy or sell hint, collected for `HOME_HINT_CUE_COLLECT_MS` (no read), and any other hint's
 * rate-limited re-read (its `recent_buys`). A trade reported once, shown or dropped, is never
 * reported again by either path.
 */
export function useHomeLive(
  query: HomeQuery,
  enabled: boolean,
  source?: FeedFreshnessSource,
  onTrades?: (trades: readonly HomeCueTrade[]) => void,
  refreshRelated?: () => Promise<unknown>,
) {
  const queueCurrent = useRef<(trade: HomeCueTrade) => void>(null);
  const client = useAppQueryClient();
  const key = JSON.stringify(query);
  const reportTrades = useEffectEvent((trades: readonly HomeCueTrade[]) => onTrades?.(trades));
  const refresh = useEffectEvent(() => refreshRelated?.());
  const trackTrades = onTrades !== undefined;
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
      if (seen.size > HOME_SEEN_TRADES) seen.delete(seen.values().next().value as string);
      return true;
    };
    const look = (hint?: FreshnessHint) => {
      if (document.visibilityState !== "visible") return;
      // The stream's first connect right after load would repeat the page's own read:
      // a page younger than the poll is current. A reconnect may have missed hints, so it reads.
      if (hint?.cause === "connect" && !hint.reconnect && Date.now() - (client.getQueryState(discover.queryKey)?.dataUpdatedAt ?? 0) < NEW_POSTS_POLL_MS) return;
      if (!gate.admit(hint)) return;
      const read = client.fetchQuery({ ...discover, staleTime: 0 }).catch(() => undefined);
      if (trackTrades) void read.then(page => {
        if (disposed || document.visibilityState !== "visible") return;
        const floor = Math.max(visibleSince, Date.now() - HOME_RECENT_BUY_MS);
        const buys = page?.recent_buys?.filter(buy => buy.occurred_at_ms > floor && remember(buy.activity_id));
        if (buys?.length) reportTrades(buys.map(buy => ({ ...buy, side: "buy" as const })));
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
    // A priced trade hint, raw (before the 1 s coalescer, so none in a burst is lost): its pop only, no read.
    let collected: HomeCueTrade[] = [];
    let flush: number | undefined;
    const queue = (trade: HomeCueTrade) => {
      if (disposed || document.visibilityState !== "visible" || !remember(trade.activity_id)) return;
      collected.push(trade);
      if (flush === undefined) flush = window.setTimeout(() => {
        flush = undefined;
        const trades = collected;
        collected = [];
        if (!disposed && document.visibilityState === "visible") reportTrades(trades);
      }, HOME_HINT_CUE_COLLECT_MS);
    };
    queueCurrent.current = trackTrades ? queue : null;
    const offHints = trackTrades ? freshness.hints?.((hint) => {
      const trade = hintTrade(hint);
      if (trade) queue(trade);
    }) : undefined;
    const onVisibility = () => { visibleSince = Date.now(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      queueCurrent.current = null;
      off();
      offHints?.();
      window.clearTimeout(flush);
      gate.cancel();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `key` stands for `query`: a query with the same text is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, key, source, trackTrades]);
  return (trade: HomeCueTrade) => queueCurrent.current?.(trade);
}
