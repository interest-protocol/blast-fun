"use client";

import { useEffect, useState } from "react";
import type { BondingLiveView, DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { tabMarketStream, type MarketStreamState } from "../market-stream-hub.ts";

export function useLiveDiscovery(enabled: boolean) {
  const [pages, setPages] = useState<Partial<Record<BondingLiveView, DiscoveryResponse>>>({});
  const [state, setState] = useState<MarketStreamState>("connecting");
  useEffect(() => {
    if (!enabled) return;
    const subscription = tabMarketStream()?.subscribe({
      pools: [],
      expected: null,
      discovery: true,
      listener: {
        state: setState,
        discovery: (page) => {
          const view = page.view as BondingLiveView;
          setPages((previous) => (previous[view]?.section.provenance?.checkpoint ?? -1) > (page.section.provenance?.checkpoint ?? -1)
            ? previous
            : { ...previous, [view]: page });
        },
      },
    });
    return () => subscription?.stop();
  }, [enabled]);
  return { pages, live: enabled && state === "live" };
}

/** Keep the authoritative live order and token and carry forward verified badges from the cached page. */
export function liveDiscoveryPage(streamed: DiscoveryResponse | undefined, cached: DiscoveryResponse | undefined) {
  if (!streamed || streamed.section.state === "unavailable" || (streamed.section.provenance?.checkpoint ?? -1) < (cached?.section.provenance?.checkpoint ?? -1)) return cached;
  if (streamed.section.state !== "available" || (cached?.section.state !== "available" && cached?.section.state !== "stale")) return streamed;
  const verified = new Set(cached.section.data.rows.filter((row) => row.verifiedTeam).map((row) => row.launchId));
  if (!verified.size) return streamed;
  return { ...streamed, section: { ...streamed.section, data: {
    ...streamed.section.data,
    rows: streamed.section.data.rows.map((row) => verified.has(row.launchId) ? { ...row, verifiedTeam: true as const } : row),
  } } };
}
