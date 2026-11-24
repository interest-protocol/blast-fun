import type { FeedItemAccountActor } from "@blast/core/web/contracts/items.ts";
import { hasPublicPnl, type HomeHolder, type HomeTrader } from "@blast/core/web/contracts/home.ts";

export type HolderSignal = Readonly<{
  actor: FeedItemAccountActor;
  kol: boolean;
  followed: boolean;
  pnlRank: number | null;
}>;

/** A global rank is evidence only when the account shares its performance. */
export function publicPnlRanks(traders: readonly HomeTrader[]): ReadonlyMap<string, number> {
  return new Map(traders.flatMap(trader => trader.actor.type === "account" && hasPublicPnl(trader) && Number.isInteger(trader.rank) && trader.rank! > 0 && trader.rank! <= 10
    ? [[trader.actor.callsign, trader.rank!] as const] : []));
}

/** Matches the supplied current-holder sample; these are never total category counts. */
export function holderSignals(holders: readonly HomeHolder[], kols: ReadonlySet<string>, follows: (callsign: string) => boolean | undefined, pnlRanks: ReadonlyMap<string, number>): readonly HolderSignal[] {
  const seen = new Set<string>();
  return holders.flatMap(holder => {
    if (holder.actor.type !== "account" || !/^\d+$/.test(holder.balance) || BigInt(holder.balance) <= 0n || seen.has(holder.actor.callsign)) return [];
    const actor = holder.actor;
    seen.add(actor.callsign);
    const kol = kols.has(actor.callsign);
    const followed = follows(actor.callsign) === true;
    const pnlRank = pnlRanks.get(actor.callsign) ?? null;
    return kol || followed || pnlRank !== null ? [{ actor, kol, followed, pnlRank }] : [];
  });
}
