import { useState } from "react";
import type { RoundsSource } from "../../../../src/components/social/rewards/rewards-page-model.ts";
import { RW_MORE, RW_PAGE_N, type RewardPayoutView } from "../../../../src/components/social/rewards/rewards-model.ts";

/** A fixture's rounds: all of them given, drawn five then ten more at a time, as the live read pages them. */
export function staticRounds(byCoin: ReadonlyMap<string, readonly RewardPayoutView[]>): RoundsSource {
  return function StaticRounds({ coin, children }) {
    const [shown, setShown] = useState(RW_PAGE_N);
    const all = byCoin.get(coin.sourceId) ?? [];
    return children({ rows: all.slice(0, shown), status: "ready", more: shown < all.length, loadingMore: false, loadMore: () => setShown((n) => n + RW_MORE), retry: () => undefined });
  };
}
