"use client";

import { useEffect, useState } from "react";

import { coinKey, tabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";
import {
  displayPriceCoinSchema,
  MARKET_STREAM_BUDGET,
  type DisplayPrice,
  type DisplayPriceFrame,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";

type Observation = DisplayPrice & Readonly<{ checkpoint: number }>;

/**
 * The coins a Home list streams prices for, at most `maxPriceCoinsPerClient` migrated coins on the page. Sticky,
 * so a poll that swaps rows 20 and 21 does not resubscribe every tab: a coin already streamed stays while it is
 * still a migrated row on the page, and free slots fill in row order, so the visible rows get live prices.
 * Sorted, so the result changes only when the membership does.
 */
export function homePriceCoins(coins: readonly HomeCoin[], previous: readonly string[] = []): readonly string[] {
  const onPage = new Set<string>();
  for (const coin of coins) {
    if (coin.lifecycle !== "migrated") continue;
    const type = coinKey(coin.coin_type);
    if (type && displayPriceCoinSchema.safeParse(type).success ) onPage.add(type);
  }
  const max = MARKET_STREAM_BUDGET.maxPriceCoinsPerClient;
  const kept = new Set(previous.filter((type) => onPage.has(type)).slice(0, max));
  for (const type of onPage) {
    if (kept.size >= max) break;
    kept.add(type);
  }
  return [...kept].sort();
}

export function useHomePrices(coins: readonly HomeCoin[], enabled: boolean) {
  const [latest, setLatest] = useState<ReadonlyMap<string, Observation>>(() => new Map());
  const [streamed, setStreamed] = useState<readonly string[]>([]);
  const picked = enabled ? homePriceCoins(coins, streamed) : [];
  const subscriptionKey = picked.join("|");
  // Remembered for the next render's pick (React's "adjust state while rendering"): set only on a change.
  if (subscriptionKey !== streamed.join("|")) setStreamed(picked);

  useEffect(() => {
    if (!subscriptionKey) return;
    const priceCoins = subscriptionKey.split("|");
    const receive = ({ checkpoint, prices }: DisplayPriceFrame) => setLatest((previous) => {
      const next = new Map(priceCoins.flatMap((type) => {
        const price = previous.get(type);
        return price ? [[type, price] as const] : [];
      }));
      let changed = next.size !== previous.size;
      for (const price of prices) {
        const current = next.get(price.coin_type);
        if (current && (checkpoint < current.checkpoint || price.as_of_ms < current.as_of_ms)) continue;
        next.set(price.coin_type, { ...price, checkpoint });
        changed = true;
      }
      return changed ? next : previous;
    });
    const subscription = tabMarketStream()?.subscribe({
      pools: [],
      priceCoins,
      expected: null,
      listener: { state: () => {}, prices: receive },
    });
    return () => subscription?.stop();
  }, [subscriptionKey]);

  return latest;
}

/** A timestamp tie can only be broken by the market watermark read alongside the HTTP price. */
export function newerHomePrice(
  latest: ReadonlyMap<string, Observation>,
  coin: HomeCoin,
  checkpoint: number,
): DisplayPrice | undefined {
  if (coin.lifecycle !== "migrated" || !latest.size) return undefined;
  const type = coinKey(coin.coin_type);
  const price = type ? latest.get(type) : undefined;
  const marketCheckpoint = coin.live_inputs?.price_checkpoint;
  if (!price || price.checkpoint < (marketCheckpoint ?? checkpoint)) return undefined;
  const asOf = coin.price_as_of_ms ?? 0;
  if (price.as_of_ms === asOf) {
    return marketCheckpoint !== undefined && price.checkpoint > marketCheckpoint ? price : undefined;
  }
  return price.as_of_ms > asOf ? price : undefined;
}
