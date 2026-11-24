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
  for (const listener of listeners.get(poolKey) ?? []) {
    listener.receive(price && !deploymentMismatch(price.provenance, listener.expected) ? price : null);
  }
}
