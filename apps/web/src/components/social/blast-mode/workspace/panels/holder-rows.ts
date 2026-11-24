import type { HomeHolderPosition } from "@blast/core/web/contracts/coin-market.ts";

/**
 * The page's rows the card's filters keep (Following only: the accounts the
 * viewer `follows`; With thesis: the holders with a why) and, when none is
 * left, the empty state's title for the filter that emptied it.
 */
export function holderRows(holders: readonly HomeHolderPosition[], { follows, withThesis }: Readonly<{ follows: ((callsign: string) => boolean) | null; withThesis: boolean }>) {
  const followed = follows ? holders.filter(holder => holder.actor?.type === "account" && follows(holder.actor.callsign)) : holders;
  const rows = withThesis ? followed.filter(holder => !!holder.why) : followed;
  if (rows.length > 0) return { rows, empty: null };
  if (followed.length === 0) return { rows, empty: follows ? "No one you follow holds this coin" : "No indexed holders" };
  return { rows, empty: follows ? "None of the holders you follow has a thesis" : "No holders with a thesis" };
}
