import { spreadMs } from "#web/lib/query/polling.ts";
import { useEffect, useEffectEvent } from "react";

import { POLL_MS } from "./blast-infra-browser";

/** The fallback poll while the market stream is live for the destination's pools (the freshness policy's visible fallback). */
export const LIVE_POLL_MS = 30_000;

/**
 * Keeps one coin page destination current, the same way for Holders and
 * Activity: `onInitialRefresh` (or `onRefresh(null)`) when first visible,
 * then `onRefresh(null)` about every `POLL_MS` (spread up to 20% per tab) while the tab is
 * visible (`LIVE_POLL_MS` while `live`: the market stream already brings its
 * changes), and when it becomes visible again. It restarts when `key`
 * changes; a change of `live` only changes the interval. The browser never
 * talks to blast-infra: each read goes through this app's
 * `/api/launchpad/market` routes. A coin's trades reach its chart live through
 * the chart's market stream (`chart-stream.ts`).
 */
export function useMarketPoll(options: Readonly<{
  key?: string;
  live?: boolean;
  onRefresh: (at: number | null) => void;
  onInitialRefresh?: () => void;
}>): void {
  const { key = "", live = false, onRefresh, onInitialRefresh } = options;
  const initialize = useEffectEvent(() => onInitialRefresh ? onInitialRefresh() : onRefresh(null));
  const refresh = useEffectEvent((at: number | null) => onRefresh(at));
  const poll = useEffectEvent(() => {
    if (document.visibilityState === "visible") refresh(null);
  });
  useEffect(() => {
    let initialized = false;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (initialized) poll();
      else {
        initialized = true;
        initialize();
      }
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [key]);
  useEffect(() => {
    const timer = setInterval(poll, spreadMs(live ? LIVE_POLL_MS : POLL_MS, Date.now()));
    return () => clearInterval(timer);
  }, [key, live]);
}
