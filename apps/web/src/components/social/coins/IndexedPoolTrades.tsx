"use client";

import { useState } from "react";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { useQuery } from "@tanstack/react-query";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { readPoolTrades } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { RECENT_TRADES_LIMIT } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { TradeList, TradeListSkeleton, type ActivityUnits } from "#web/components/launchpad/activity/ActivityView.tsx";
import { venueTradeRow, type VenuePoolKey } from "#web/components/launchpad/activity/activity-live.ts";
import styles from "#web/components/launchpad/activity/Activity.module.css";
import { LIVE_POLL_MS } from "#web/components/launchpad/use-market-poll.ts";
import { PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { indexedPoolPolling, readIndexedPool } from "./indexed-pool-query.ts";

const UNAVAILABLE = "Trades couldn’t load";
const POOL_TRADES_LOOKBACK = 20;

/** The newest swaps across a coin's pools, newest first; one pool's outage fails the list rather than hide its swaps. */
async function recentPoolTrades(poolKeys: readonly VenuePoolKey[], signal: AbortSignal) {
  const reads = await Promise.all(poolKeys.map(async (poolKey) => {
    const read = await readIndexedPool(UNAVAILABLE, signal, (market) => readPoolTrades(poolKey, { limit: POOL_TRADES_LOOKBACK }, market));
    if (read.status === "unavailable" || read.data.kind === "refused") throw new PublicError(UNAVAILABLE, { code: "service_unavailable" });
    return { stale: read.status === "stale", rows: read.data.value.trades.map((trade) => venueTradeRow(trade, poolKey)) };
  }));
  const rows = reads.flatMap((read) => read.rows).sort((a, b) => compareEventCursors(b.position, a.position));
  return { stale: reads.some((read) => read.stale), rows: rows.slice(0, POOL_TRADES_LOOKBACK) };
}

export function IndexedPoolTrades({ poolKeys, units }: Readonly<{ poolKeys: readonly VenuePoolKey[]; units: ActivityUnits }>) {
  const { explorer } = useDevicePrefs();
  const [heldRows, setHeldRows] = useState<readonly ActivityRow[] | null>(null);
  const query = useQuery({
    queryKey: ["indexed-pool-trades", ...poolKeys],
    queryFn: ({ signal }) => recentPoolTrades(poolKeys, signal),
    ...indexedPoolPolling(LIVE_POLL_MS),
  }, useAppQueryClient());
  const rows = heldRows ?? query.data?.rows;
  if (query.isPending) return <TradeListSkeleton />;
  if (!rows || (query.isError && !rows.length)) {
    return <EmptyState title={UNAVAILABLE} role="alert" action={<Button size="sm" onClick={() => void query.refetch()}>Try again</Button>}>
      <DiagnosticCode message={publicErrorMessage(query.error, UNAVAILABLE)} generic={UNAVAILABLE} />
    </EmptyState>;
  }
  return <>
    {query.data?.stale || query.isError ? <p className={styles.note} role="status">Trade updates delayed.</p> : null}
    {rows.length
      ? <TradeList rows={rows.slice(0, RECENT_TRADES_LIMIT)} availableRows={rows}
        units={units} explorer={explorer} next={null} hold={(held) => setHeldRows(held ? rows : null)} />
      : <EmptyState title="No swaps indexed yet">New swaps in this pool will appear here.</EmptyState>}
  </>;
}
