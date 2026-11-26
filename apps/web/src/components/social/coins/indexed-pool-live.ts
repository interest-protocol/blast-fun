import type { QueryClient } from "@tanstack/react-query";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { followLiveTrades, type VenuePoolKey } from "#web/components/launchpad/activity/activity-live.ts";
import type { MarketStreamHub, MarketStreamState } from "#web/components/launchpad/market-stream-hub.ts";

export const POOL_TRADES_LOOKBACK = 20;

/** One pool's newest swaps and the checkpoint the read answered at (null when it did not say). */
export type PoolTradesRead = Readonly<{ stale: boolean; rows: readonly ActivityRow[]; checkpoint: number | null }>;

export const poolTradesKey = (poolKey: string) => ["indexed-pool-trades", poolKey] as const;

/** `read`, unless the pool already shows a newer one: a slow poll never replaces a read pinned to a later fence. */
export function newestRead(client: QueryClient, poolKey: string, read: PoolTradesRead): PoolTradesRead {
  const shown = client.getQueryData<PoolTradesRead>(poolTradesKey(poolKey));
  return shown && (shown.checkpoint ?? -1) > (read.checkpoint ?? -1) ? shown : read;
}

/** `rows` with `fresh` in place, newest first, once each, cut to the lookback. */
export function withLiveRows(rows: readonly ActivityRow[], fresh: readonly ActivityRow[]): ActivityRow[] {
  const known = new Set(rows.map((row) => row.position));
  return [...fresh.filter((row) => !known.has(row.position)), ...rows]
    .sort((a, b) => compareEventCursors(b.position, a.position))
    .slice(0, POOL_TRADES_LOOKBACK);
}

export type PoolTradesFollow = Readonly<{
  hub: Pick<MarketStreamHub, "subscribe">;
  client: QueryClient;
  poolKeys: readonly VenuePoolKey[];
  /** One pool's read; `at`: the checkpoint it must reach (its fence). */
  read: (poolKey: VenuePoolKey, signal: AbortSignal, at: number | null) => Promise<PoolTradesRead>;
  /** A streamed trade's row. */
  onRow: (row: ActivityRow) => void;
  onState: (poolKey: VenuePoolKey, state: MarketStreamState) => void;
  schedule: (run: () => void, ms: number) => () => void;
  now: () => number;
  random: () => number;
}>;

/**
 * Each pool on its own stream subscription: a streamed trade is a row at once, and each fence asks
 * for a read of that pool pinned to its checkpoint (asked again while a cached answer is behind), stored
 * in the pool's query unless a newer read is already there. Returns the stop.
 */
export function followPoolTrades(options: PoolTradesFollow): () => void {
  const { client } = options;
  const reads = new AbortController();
  const stops = options.poolKeys.map((poolKey) => followLiveTrades({
    hub: options.hub,
    // Venue pools only: a venue swap's row needs no launch.
    launchId: "",
    pools: [poolKey],
    expected: null,
    feed: {
      addLive: (row) => {
        options.onRow(row);
        return false;
      },
      readThrough: () => client.getQueryData<PoolTradesRead>(poolTradesKey(poolKey))?.checkpoint ?? null,
      refresh: async (_manual, at) => {
        try {
          const read = await options.read(poolKey, reads.signal, at ?? null);
          client.setQueryData(poolTradesKey(poolKey), newestRead(client, poolKey, read));
          return true;
        } catch {
          return false;
        }
      },
    },
    onState: (state) => options.onState(poolKey, state),
    schedule: options.schedule,
    now: options.now,
    random: options.random,
  }));
  return () => {
    for (const stop of stops) stop();
    reads.abort();
  };
}

/** A live pool's query needs no timer; any other pool keeps its poll. */
export function poolRefetchInterval<Q extends { state: { status: string } }>(live: ReadonlySet<string>, poolKey: string, poll: (query: Q) => number | false) {
  return (query: Q) => live.has(poolKey) && query.state.status !== "error" ? false : poll(query);
}
