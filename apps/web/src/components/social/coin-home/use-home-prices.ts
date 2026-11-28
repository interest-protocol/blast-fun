"use client";

import { useEffect, useEffectEvent, useState } from "react";

import { coinKey, tabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";
import {
  displayPriceCoinSchema,
  MARKET_STREAM_BUDGET,
  type DisplayPrice,
  type DisplayPriceFrame,
  type MarketTradeCue,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";

/** The coin's latest own move, apart from its quote's: when it landed and which way it went against the quote. */
export type HomeTrade = Readonly<{ at: number; direction: 1 | -1 }>;
type Observation = DisplayPrice & Readonly<{ checkpoint: number; trade: HomeTrade | null }>;

/** Within this of the frame's common move, a coin moved with its quote: a SUI tick, not a trade. */
const QUOTE_MOVE_TOLERANCE = 1e-5;

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

export function useHomePrices(coins: readonly HomeCoin[], enabled: boolean, onTradeCue?: (cue: MarketTradeCue) => void) {
  const tradeCues = onTradeCue !== undefined;
  const receiveCue = useEffectEvent((cue: MarketTradeCue) => onTradeCue?.(cue));
  const [latest, setLatest] = useState<ReadonlyMap<string, Observation>>(() => new Map());
  const [streamed, setStreamed] = useState<readonly string[]>([]);
  const picked = enabled ? homePriceCoins(coins, streamed) : [];
  const subscriptionKey = picked.join("|");
  // Remembered for the next render's pick (React's "adjust state while rendering"): set only on a change.
  if (subscriptionKey !== streamed.join("|")) setStreamed(picked);

  useEffect(() => {
    if (!subscriptionKey) return;
    const priceCoins = subscriptionKey.split("|");
    const receive = (frame: DisplayPriceFrame) => setLatest((previous) => observeFrame(previous, priceCoins, frame));
    const subscription = tabMarketStream()?.subscribe({
      pools: [],
      priceCoins,
      expected: null,
      listener: { state: () => {}, prices: receive, ...(tradeCues ? { tradeCue: (cue) => receiveCue(cue) } : {}) },
    });
    return () => subscription?.stop();
  }, [subscriptionKey, tradeCues]);

  return latest;
}

/**
 * One frame applied to the streamed coins. A quote move (SUI) moves every coin on that quote by the same ratio in one
 * read, so the frame's common move is the ratio at least two moved coins share (1 when none do). A coin that moved
 * apart from it traded, up or down against it. A coin's first price, or a move smaller than the tolerance, is no trade.
 */
export function observeFrame(
  previous: ReadonlyMap<string, Observation>,
  priceCoins: readonly string[],
  { checkpoint, prices }: DisplayPriceFrame,
): ReadonlyMap<string, Observation> {
  const next = new Map(priceCoins.flatMap((type) => {
    const price = previous.get(type);
    return price ? [[type, price] as const] : [];
  }));
  let changed = next.size !== previous.size;
  const fresh = prices.filter((price) => {
    const current = next.get(price.coin_type);
    return !current || (checkpoint >= current.checkpoint && price.as_of_ms >= current.as_of_ms);
  });
  const ratios = new Map(fresh.flatMap((price) => {
    const before = Number(next.get(price.coin_type)?.usd_price);
    const ratio = Number(price.usd_price) / before;
    return before > 0 && Number.isFinite(ratio) ? [[price.coin_type, ratio] as const] : [];
  }));
  const common = quoteMove([...ratios.values()]);
  for (const price of fresh) {
    const ratio = ratios.get(price.coin_type);
    const apart = ratio === undefined ? 0 : ratio / common - 1;
    const trade = Math.abs(apart) > QUOTE_MOVE_TOLERANCE && Math.abs(ratio! - 1) > QUOTE_MOVE_TOLERANCE
      ? { at: price.as_of_ms, direction: apart > 0 ? 1 as const : -1 as const }
      : next.get(price.coin_type)?.trade ?? null;
    next.set(price.coin_type, { ...price, checkpoint, trade });
    changed = true;
  }
  return changed ? next : previous;
}

function quoteMove(ratios: readonly number[]): number {
  const moved = ratios.filter((ratio) => Math.abs(ratio - 1) > QUOTE_MOVE_TOLERANCE);
  let common = 1;
  let shared = 1;
  for (const ratio of moved) {
    const count = moved.filter((other) => Math.abs(other / ratio - 1) <= QUOTE_MOVE_TOLERANCE).length;
    if (count > shared) [common, shared] = [ratio, count];
  }
  return common;
}

/** The coin's latest trade on this tab's stream, whichever read won its price. */
export function homeTrade(latest: ReadonlyMap<string, Observation>, coin: HomeCoin): HomeTrade | null {
  const type = coin.lifecycle === "migrated" ? coinKey(coin.coin_type) : null;
  return (type && latest.get(type)?.trade) || null;
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
