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

export function useHomePrices(coins: readonly HomeCoin[], enabled: boolean) {
  const [latest, setLatest] = useState<ReadonlyMap<string, Observation>>(() => new Map());
  const keys = new Set<string>();
  if (enabled) {
    for (const coin of coins) {
      if (coin.lifecycle !== "migrated") continue;
      const type = coinKey(coin.coin_type);
      if (type && displayPriceCoinSchema.safeParse(type).success) keys.add(type);
    }
  }
  const subscriptionKey = [...keys].sort().slice(0, MARKET_STREAM_BUDGET.maxPriceCoinsPerClient).join("|");

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
