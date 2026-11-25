"use client";

import { useEffect, useState } from "react";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { useQuery, type QueryClient } from "@tanstack/react-query";
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
import { POLL_MS } from "#web/components/launchpad/blast-infra-browser.ts";
import { tabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";
import { useLiveScreen } from "#web/components/launchpad/coin/LiveScreen.tsx";
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

/** `rows` with `fresh` in place, newest first, once each, cut to the lookback. */
function withLiveRows(rows: readonly ActivityRow[], fresh: readonly ActivityRow[]): ActivityRow[] {
  const known = new Set(rows.map((row) => row.position));
  return [...fresh.filter((row) => !known.has(row.position)), ...rows]
    .sort((a, b) => compareEventCursors(b.position, a.position))
    .slice(0, POOL_TRADES_LOOKBACK);
}

/**
 * The live screen's trades: the first read, then each trade the tab's stream brings for these pools,
 * kept apart from the read so a trade that lands before the read answers still shows. The list
 * re-reads on a timer only while the stream is not live, and once each time the stream comes back,
 * so a gap's trades are not lost. The screen streams its main pool only, so a list over several
 * pools (SUI) keeps its timer for the others.
 */
function useLiveTrades(client: QueryClient, queryKey: readonly unknown[], coinType: string | null, poolKeys: readonly VenuePoolKey[], enabled: boolean) {
  const [live, setLive] = useState(false);
  const [streamed, setStreamed] = useState<Readonly<{ pools: string; rows: readonly ActivityRow[] }>>({ pools: "", rows: [] });
  const pools = poolKeys.join(",");
  useEffect(() => {
    const hub = enabled && coinType ? tabMarketStream() : null;
    if (!hub || !coinType) return;
    let wasLive = false;
    let dropped = false;
    const unsubscribe = hub.observe(coinType, {
      live: (next) => {
        if (next && dropped) void client.refetchQueries({ queryKey, exact: true });
        dropped = wasLive && !next ? true : next ? false : dropped;
        wasLive = next;
        setLive(next);
      },
      trade: ({ poolKey, trade }) => {
        const pool = poolKeys.find((key) => key === poolKey);
        if (pool) setStreamed((held) => ({ pools, rows: withLiveRows(held.pools === pools ? held.rows : [], [venueTradeRow(trade, pool)]) }));
      },
    });
    return () => unsubscribe();
    // `poolKeys` and `queryKey` are keyed by `pools`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, coinType, pools, enabled]);
  return { live: enabled && live && poolKeys.length === 1, streamed: streamed.pools === pools ? streamed.rows : [] };
}

export function IndexedPoolTrades({ poolKeys, units }: Readonly<{ poolKeys: readonly VenuePoolKey[]; units: ActivityUnits }>) {
  const { explorer } = useDevicePrefs();
  const [heldRows, setHeldRows] = useState<readonly ActivityRow[] | null>(null);
  const client = useAppQueryClient();
  const liveScreen = useLiveScreen();
  const queryKey = ["indexed-pool-trades", ...poolKeys];
  const { live, streamed } = useLiveTrades(client, queryKey, units.coinType ?? null, poolKeys, liveScreen);
  const polling = indexedPoolPolling(liveScreen && poolKeys.length === 1 ? POLL_MS : LIVE_POLL_MS);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => recentPoolTrades(poolKeys, signal),
    ...polling,
    refetchInterval: (query) => live && query.state.status !== "error" ? false : polling.refetchInterval(query),
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
