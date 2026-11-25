"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { tabActivityHints } from "#web/components/social/home/activity-hints.ts";
import { spreadMs } from "#web/lib/query/polling.ts";
import { reportCoinView } from "#web/modules/launchpad-telemetry/client.ts";

import { useLiveListening } from "./LiveScreen.tsx";

/**
 * The coin page's browser side. It reports the first view of a coin the page
 * shows as tradable (once per page; never for one that is not), and re-reads
 * the page from the server about every `refreshMs` (spread up to 20% per tab)
 * while the tab is visible, so
 * lifecycle changes, conflicts and outages update in place on the same URL.
 * A change of the coin's own identity (its name, symbol, description or icon)
 * re-reads the page at once: the tab's hint stream names the coin, and the
 * page's server read takes the new identity from blast-infra uncached.
 * With `restWhileListening` (the live screen on a healthy read), a tick is skipped while the
 * screen's stream is live and carrying the coin's stats; once it drops, the timer reads again.
 */
export function CoinLive({
  launchId,
  coinType,
  tradable,
  refreshMs,
  restWhileListening = false,
}: Readonly<{ launchId: string; coinType: string | null; tradable: boolean; refreshMs: number; restWhileListening?: boolean }>) {
  const router = useRouter();
  const listening = useLiveListening();
  const resting = useRef(false);
  useEffect(() => {
    resting.current = restWhileListening && listening;
  }, [restWhileListening, listening]);

  useEffect(() => {
    if (tradable) reportCoinView(launchId);
  }, [launchId, tradable]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !resting.current) router.refresh();
    }, spreadMs(refreshMs, Date.now()));
    return () => window.clearInterval(timer);
  }, [router, refreshMs]);

  useEffect(() => {
    const hints = coinType === null ? null : tabActivityHints();
    if (hints === null) return undefined;
    return hints.subscribe("coin", (hint) => {
      if (hint?.cause === "hint" && hint.coinType === coinType) router.refresh();
    });
  }, [router, coinType]);

  return null;
}
