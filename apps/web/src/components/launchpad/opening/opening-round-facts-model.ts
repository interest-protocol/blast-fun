

import { WORKLOAD_ROUTES } from "@blast/core/modules/read-routing/resources.ts";

import type { ChartRoundUpdate } from "../chart/chart-live-round";
import type { BidderCount } from "../coin/CoinExecution";
import { atomsGrouped } from "@blast/core/web/format.ts";

export const sui = (atoms: bigint) => `${atomsGrouped(atoms, 9)} SUI`;

/** The page's indexed count until a pushed round from a later checkpoint replaces it. */
export function liveBidderCount(bidders: BidderCount, pushed: ChartRoundUpdate | null): Readonly<{ count: number; stale: boolean }> {
  const checkpoint = pushed?.provenance.checkpoint ?? null;
  if (!pushed || !bidders.live || pushed.poolKey !== bidders.live.poolKey || checkpoint === null || checkpoint <= (bidders.live.checkpoint ?? -1)) return bidders;
  const { lagMs } = pushed.provenance;
  return { count: pushed.openingRound.bidderCount, stale: lagMs !== null && lagMs > WORKLOAD_ROUTES.market.maxLagMs };
}
