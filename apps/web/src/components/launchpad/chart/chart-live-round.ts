import type { OpeningRound } from "@blast/core/modules/launchpad-contract/activity.ts";
import { deploymentMismatch, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";

/** A curve pool's opening round as its pushed `opening_round` frame left it at `provenance.checkpoint`. */
export type ChartRoundUpdate = Readonly<{ poolKey: string; openingRound: OpeningRound; provenance: Provenance }>;

type Listener = Readonly<{ expected: ExpectedDeployment | null; receive: (round: ChartRoundUpdate) => void }>;
const listeners = new Map<string, Set<Listener>>();

/** Shares the chart stream's opening-round frames with the coin page, without another connection. */
export function subscribeChartRound(poolKey: string, expected: ExpectedDeployment | null, onRound: Listener["receive"]): () => void {
  const pool = listeners.get(poolKey) ?? new Set<Listener>();
  const listener = { expected, receive: onRound };
  pool.add(listener);
  listeners.set(poolKey, pool);
  return () => {
    pool.delete(listener);
    if (pool.size === 0) listeners.delete(poolKey);
  };
}

export function publishChartRound(round: ChartRoundUpdate): void {
  for (const listener of listeners.get(round.poolKey) ?? []) {
    if (!deploymentMismatch(round.provenance, listener.expected)) listener.receive(round);
  }
}
