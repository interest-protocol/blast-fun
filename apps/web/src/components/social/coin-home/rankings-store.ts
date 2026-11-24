import { createContext } from "react";
import type { Rankings } from "./use-rankings";

export type RankingHandle = Pick<Rankings, "pending" | "incoming" | "update">;

export type RankingsStore = Readonly<{
  get: () => RankingHandle | null;
  set: (next: RankingHandle | null) => void;
  subscribe: (listener: () => void) => () => void;
}>;

/** One per Home: the list that shows registers its controls; the Coins header draws them. */
export function createRankingsStore(): RankingsStore {
  let current: RankingHandle | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => { current = next; for (const listener of listeners) listener(); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const RankingsSlot = createContext<RankingsStore | null>(null);
