"use client";

import { useEffect, useState } from "react";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { useQueries, type QueryClient } from "@tanstack/react-query";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { MARKET_STREAM_BUDGET } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { readPoolTrades } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { RECENT_TRADES_LIMIT } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { TradeList, TradeListSkeleton, type ActivityUnits } from "#web/components/launchpad/activity/ActivityView.tsx";
import { venueTradeRow, type VenuePoolKey } from "#web/components/launchpad/activity/activity-live.ts";
import styles from "#web/components/launchpad/activity/Activity.module.css";
import { atCheckpoint } from "#web/components/launchpad/blast-infra-browser.ts";
import { LIVE_POLL_MS } from "#web/components/launchpad/use-market-poll.ts";
import { tabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";
import { useLiveScreen } from "#web/components/launchpad/coin/LiveScreen.tsx";
import { PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { indexedPoolPolling, readIndexedPool } from "./indexed-pool-query.ts";
import { followPoolTrades, newestRead, poolRefetchInterval, poolTradesKey, POOL_TRADES_LOOKBACK, withLiveRows, type PoolTradesRead } from "./indexed-pool-live.ts";

const UNAVAILABLE = "Trades couldn’t load";

/** One pool's newest swaps; `at`: a checkpoint the read must reach (the pool's stream fence), or null for a poll. */
async function readRecentPoolTrades(poolKey: VenuePoolKey, signal: AbortSignal, at: number | null): Promise<PoolTradesRead> {
  const read = await readIndexedPool(UNAVAILABLE, signal, (market) => readPoolTrades(poolKey, { limit: POOL_TRADES_LOOKBACK }, atCheckpoint(market, at)));
  if (read.status === "unavailable" || read.data.kind === "refused") throw new PublicError(UNAVAILABLE, { code: "service_unavailable" });
  return { stale: read.status === "stale", rows: read.data.value.trades.map((trade) => venueTradeRow(trade, poolKey)), checkpoint: read.provenance.checkpoint };
}

/**
 * The live screen's trades, pool by pool: each trade the tab's stream brings is a row at once, kept
 * apart from the reads so a trade that lands before a read answers still shows. Each fence asks for a
 * read of that pool that reaches the fence (pinned to its checkpoint, so a cached answer cannot leave a
 * gap), and a live pool needs no timer; a pool that is not live polls on its own while the other streams.
 * A list over more pools than one stream carries stays on its polls.
 */
function useLiveTrades(client: QueryClient, poolKeys: readonly VenuePoolKey[], enabled: boolean) {
  const [live, setLive] = useState<Readonly<{ pools: string; live: ReadonlySet<string> }>>({ pools: "", live: new Set() });
  const [streamed, setStreamed] = useState<Readonly<{ pools: string; rows: readonly ActivityRow[] }>>({ pools: "", rows: [] });
  const pools = poolKeys.join(",");
  useEffect(() => {
    const hub = enabled && poolKeys.length <= MARKET_STREAM_BUDGET.maxPoolsPerClient ? tabMarketStream() : null;
    if (!hub) return;
    return followPoolTrades({
      hub,
      client,
      poolKeys,
      read: readRecentPoolTrades,
      onRow: (row) => setStreamed((held) => ({ pools, rows: withLiveRows(held.pools === pools ? held.rows : [], [row]) })),
      onState: (poolKey, state) => setLive((held) => {
        const next = new Set(held.pools === pools ? held.live : []);
        if (state === "live") next.add(poolKey);
        else next.delete(poolKey);
        return { pools, live: next };
      }),
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      now: Date.now,
      random: Math.random,
    });
    // `poolKeys` is keyed by `pools`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pools, enabled]);
  return {
    live: enabled && live.pools === pools ? live.live : new Set<string>(),
    streamed: streamed.pools === pools ? streamed.rows : [],
  };
}

export function IndexedPoolTrades({ poolKeys, units }: Readonly<{ poolKeys: readonly VenuePoolKey[]; units: ActivityUnits }>) {
  const { explorer } = useDevicePrefs();
  const [heldRows, setHeldRows] = useState<readonly ActivityRow[] | null>(null);
  const client = useAppQueryClient();
  const liveScreen = useLiveScreen();
  const { live, streamed } = useLiveTrades(client, poolKeys, liveScreen);
  const polling = indexedPoolPolling(LIVE_POLL_MS);
  const query = useQueries({
    queries: poolKeys.map((poolKey) => ({
      queryKey: poolTradesKey(poolKey),
      queryFn: async ({ signal }: { signal: AbortSignal }) => newestRead(client, poolKey, await readRecentPoolTrades(poolKey, signal, null)),
      ...polling,
      refetchInterval: poolRefetchInterval(live, poolKey, polling.refetchInterval),
    })),
    // One pool's outage fails the list rather than hide its swaps.
    combine: (results) => {
      const failed = results.find((result) => result.isError);
      const reads = results.flatMap((result) => result.data ? [result.data] : []);
      return {
        isPending: results.some((result) => result.isPending),
        isError: failed !== undefined,
        error: failed?.error ?? null,
        data: reads.length === results.length
          ? { stale: reads.some((read) => read.stale), rows: reads.flatMap((read) => read.rows).sort((a, b) => compareEventCursors(b.position, a.position)).slice(0, POOL_TRADES_LOOKBACK) }
          : undefined,
        refetch: () => Promise.all(results.map((result) => result.refetch())),
      };
    },
  }, client);
  const rows = heldRows ?? (query.data ? withLiveRows(query.data.rows, streamed) : undefined);
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
      : <EmptyState title="No swaps indexed yet">New swaps will appear here.</EmptyState>}
  </>;
}
