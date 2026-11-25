"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { tabActivityHints } from "#web/components/social/home/activity-hints.ts";
import { spreadMs } from "#web/lib/query/polling.ts";
import { reportCoinView } from "#web/modules/launchpad-telemetry/client.ts";

/**
 * The coin page's browser side. It reports the first view of a coin the page
 * shows as tradable (once per page; never for one that is not), and re-reads
 * the page from the server about every `refreshMs` (spread up to 20% per tab)
 * while the tab is visible (never when `refreshMs` is null: the live screen listens instead), so
 * lifecycle changes, conflicts and outages update in place on the same URL.
 * A change of the coin's own identity (its name, symbol, description or icon)
 * re-reads the page at once: the tab's hint stream names the coin, and the
 * page's server read takes the new identity from blast-infra uncached.
 */
export function CoinLive({
  launchId,
  coinType,
  tradable,
  refreshMs,
}: Readonly<{ launchId: string; coinType: string | null; tradable: boolean; refreshMs: number | null }>) {
  const router = useRouter();

  useEffect(() => {
    if (tradable) reportCoinView(launchId);
  }, [launchId, tradable]);

  useEffect(() => {
    if (refreshMs === null) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
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
