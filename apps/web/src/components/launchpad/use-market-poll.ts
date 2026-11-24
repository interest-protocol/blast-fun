import { spreadMs } from "#web/lib/query/polling.ts";
import { useEffect, useEffectEvent } from "react";

import { POLL_MS } from "./blast-infra-browser";

/** The fallback poll while the market stream is live for the destination's pools (the freshness policy's visible fallback). */
export const LIVE_POLL_MS = 30_000;

/**
 * Keeps one coin page destination current, the same way for Holders and
 * Activity: `onRefresh(null)` at once, about every `POLL_MS` (spread up to 20% per tab) while the tab is
 * visible (`LIVE_POLL_MS` while `live`: the market stream already brings its
 * changes), and when it becomes visible again. It restarts when `key`
 * changes; a change of `live` only changes the interval. The browser never
 * talks to blast-infra: each read goes through this app's
 * `/api/launchpad/market` routes. A coin's trades reach its chart live through
 * the chart's market stream (`chart-stream.ts`).
 */
export function useMarketPoll(options: Readonly<{ key?: string; live?: boolean; onRefresh: (at: number | null) => void }>): void {
  const { key = "", live = false, onRefresh } = options;
  const refresh = useEffectEvent((at: number | null) => onRefresh(at));
  const poll = useEffectEvent(() => {
    if (document.visibilityState === "visible") refresh(null);
  });
  useEffect(() => {
    poll();
    document.addEventListener("visibilitychange", poll);
    return () => document.removeEventListener("visibilitychange", poll);
  }, [key]);
  useEffect(() => {
    const timer = setInterval(poll, spreadMs(live ? LIVE_POLL_MS : POLL_MS, Date.now()));
    return () => clearInterval(timer);
  }, [key, live]);
}
