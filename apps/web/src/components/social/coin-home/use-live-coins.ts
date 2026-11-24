"use client";

import { useMemo, useState } from "react";

import { savedListContent, useListContent } from "#web/components/blast-ui/list-restoration.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";

import { homeCoinKey } from "./home-model";

/** A held row can outlive the HTTP page that provided it. */
export type RankedCoin = HomeCoin & Readonly<{ readCheckpoint?: number }>;
type RankingOptions = Readonly<{ paused?: boolean; revision?: number; holdIncoming?: boolean; checkpoint?: number }>;

function freshValues(coins: readonly RankedCoin[], latest: readonly RankedCoin[] | undefined): readonly RankedCoin[] {
  const fresh = new Map((latest ?? []).map(coin => [homeCoinKey(coin), coin]));
  return coins.map(coin => fresh.get(homeCoinKey(coin)) ?? coin);
}

/** Membership of this page, independent of changes to rank or to a coin's figures. */
export function incomingCoinCount(shown: readonly HomeCoin[], latest: readonly HomeCoin[]): number {
  const incoming = new Set(latest.map(homeCoinKey));
  for (const coin of shown) incoming.delete(homeCoinKey(coin));
  return incoming.size;
}

type RankingState = Readonly<{
  revision: number;
  from: readonly RankedCoin[] | undefined;
  coins: readonly RankedCoin[];
}>;

function shouldAdopt(shown: RankingState, latest: readonly RankedCoin[] | undefined, options: RankingOptions): latest is readonly RankedCoin[] {
  if (!latest) return false;
  if (shown.from === undefined || shown.revision !== options.revision) return true;
  if (options.paused || shown.from === latest) return false;
  return !options.holdIncoming || shown.coins.length === 0 || incomingCoinCount(shown.coins, latest) === 0;
}

/** Hold positions when paused, but keep the last observed values. View changes and explicit updates adopt the whole result. */
export function useLiveCoins(read: readonly HomeCoin[] | undefined, key: string, { paused = false, revision = 0, holdIncoming = false, checkpoint }: RankingOptions = {}): readonly RankedCoin[] {
  const latest = useMemo(() => checkpoint === undefined ? read : read?.map(coin => ({ ...coin, readCheckpoint: checkpoint })), [read, checkpoint]);
  const [shown, setShown] = useState(() => ({
    key, revision, from: latest, seen: latest,
    coins: freshValues(savedListContent<readonly RankedCoin[]>(key) ?? latest ?? [], latest),
  }));
  let current = shown;
  const newView = shown.key !== key;
  const adopt = shouldAdopt(shown, latest, { paused, revision, holdIncoming });
  if (newView || adopt || shown.seen !== latest || shown.revision !== revision) {
    const order = newView ? latest ?? savedListContent<readonly RankedCoin[]>(key) ?? [] : adopt ? latest : shown.coins;
    current = {
      key, revision, from: newView || adopt ? latest : shown.from, seen: latest,
      coins: freshValues(order, latest),
    };
    setShown(current);
  }
  useListContent(key, current.coins, saved => setShown({ key, revision, from: latest, seen: latest, coins: freshValues(saved, latest) }));
  return current.coins;
}
