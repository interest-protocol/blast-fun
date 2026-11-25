import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { deploymentMismatch, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";

/** Raw quote atoms per meme atom; consumers apply the coin's decimals. */
export type ChartPriceUpdate = Readonly<{ price: string; poolKey: string; cursor: string | null; provenance: Provenance }>;

/** HTTP includes the whole checkpoint; a trade cursor may only cover its first transaction. */
export function priceCoversHeader(update: ChartPriceUpdate, checkpoint: number | null): boolean {
  const streamed = update.provenance.checkpoint;
  if (streamed === null) return false;
  return update.cursor === null ? streamed >= (checkpoint ?? -1) : streamed > (checkpoint ?? -1);
}

type Listener = Readonly<{ expected: ExpectedDeployment | null; receive: (price: ChartPriceUpdate | null) => void }>;
const listeners = new Map<string, Set<Listener>>();
const currentPrices = new Map<string, ChartPriceUpdate>();
const noPrice = () => null;

const ownTrades = new Map<string, number>();
const ownTradeListeners = new Set<() => void>();

/** The viewer's own trade on `launchId` settled at `checkpoint`. */
export function noteOwnTrade(launchId: string, checkpoint: number): void {
  if (checkpoint <= (ownTrades.get(launchId) ?? -1)) return;
  ownTrades.set(launchId, checkpoint);
  for (const listener of ownTradeListeners) listener();
}

function subscribeOwnTrades(changed: () => void): () => void {
  ownTradeListeners.add(changed);
  return () => ownTradeListeners.delete(changed);
}

/** The launch whose pool `poolKey` prices, for `useChartPrice` calls below the one that names it. */
export const ChartPriceLaunch = createContext<Readonly<{ poolKey: string | null; launchId: string }> | null>(null);

/**
 * The pool's best known price. `checkpoint` holds it to a read the caller already shows. With a
 * launch (`launchId`, or `ChartPriceLaunch` above), a price after the viewer's own trade counts
 * once its checkpoint includes that trade. A trade frame from that checkpoint may precede the
 * viewer's own transaction, but the stream delivers the rest of the checkpoint with it.
 */
export function useChartPrice(poolKey: string | null, checkpoint: number | null = null, ownLaunch?: string): ChartPriceUpdate | null {
  const launch = useContext(ChartPriceLaunch);
  const launchId = ownLaunch ?? (launch && launch.poolKey === poolKey ? launch.launchId : null);
  const ownTrade = useSyncExternalStore(subscribeOwnTrades, () => launchId === null ? null : ownTrades.get(launchId) ?? null, noPrice);
  const subscribe = useCallback((changed: () => void) => poolKey
    ? subscribeChartPrice(poolKey, null, changed)
    : () => {}, [poolKey]);
  const snapshot = () => poolKey ? currentPrices.get(poolKey) ?? null : null;
  const price = useSyncExternalStore(subscribe, snapshot, noPrice);
  if (!price || !priceCoversHeader(price, checkpoint)) return null;
  return ownTrade === null || (price.provenance.checkpoint ?? -1) >= ownTrade ? price : null;
}

/** Source progress expires independently of transport liveness or the age of the last swap. */
export function chartPriceRemaining(provenance: Provenance, maxLagMs: number, now: number): number {
  const { checkpoint, timestampMs, lagMs } = provenance;
  if (checkpoint === null || timestampMs === null || lagMs === null) return 0;
  return maxLagMs - Math.max(lagMs, now - timestampMs);
}

/** Shares the chart's accepted prices with the coin header, without another connection. */
export function subscribeChartPrice(poolKey: string, expected: ExpectedDeployment | null, onPrice: Listener["receive"]): () => void {
  const pool = listeners.get(poolKey) ?? new Set<Listener>();
  const listener = { expected, receive: onPrice };
  pool.add(listener);
  listeners.set(poolKey, pool);
  return () => {
    pool.delete(listener);
    if (pool.size === 0) listeners.delete(poolKey);
  };
}

export function publishChartPrice(poolKey: string, price: ChartPriceUpdate | null): void {
  if (price) currentPrices.set(poolKey, price);
  else currentPrices.delete(poolKey);
  for (const listener of listeners.get(poolKey) ?? []) {
    listener.receive(price && !deploymentMismatch(price.provenance, listener.expected) ? price : null);
  }
}
