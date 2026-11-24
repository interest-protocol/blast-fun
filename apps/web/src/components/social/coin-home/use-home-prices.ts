"use client";

import { useEffect, useEffectEvent, useState } from "react";

import { coinKey, tabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";
import {
  displayPriceCoinSchema,
  MARKET_STREAM_BUDGET,
  type DisplayPrice,
  type DisplayPriceFrame,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import { blastModeCovering, onUncover } from "../blast-mode/live/mode-cover";
import type { RankedCoin } from "./use-live-coins";

type StampedPrice = DisplayPrice & Readonly<{ checkpoint: number }>;
type Observation = StampedPrice & Readonly<{ session: object | null }>;

type ActivityScope = Readonly<{ checkpoint: number }>;
export type HomePriceMove = Readonly<{ coin: HomeCoin; bps: number; seenAtMs: number; scope: ActivityScope }>;
type PriceState = Readonly<{ latest: ReadonlyMap<string, Observation>; move: HomePriceMove | null }>;
type ActivityView = Readonly<{ coins: readonly RankedCoin[]; scope: ActivityScope }>;

export const HOME_PRICE_MOVE_FRESH_MS = 120_000;
const HOME_PRICE_MOVE_CUE_GAP_MS = 5_000;
const HOME_PRICE_MOVE_MIN_BPS = 100;

export function useHomePrices(coins: readonly RankedCoin[], enabled: boolean, activityScope?: ActivityScope) {
  const [state, setState] = useState<PriceState>(() => ({ latest: new Map(), move: null }));
  const getActivityView = useEffectEvent((): ActivityView | null => (
    activityScope ? { coins, scope: activityScope } : null
  ));
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
    let live = false;
    let session = {};
    // The first observation after subscribing, reconnecting, or returning to the page is a baseline.
    const reset = () => { session = {}; };
    const receive = (frame: DisplayPriceFrame) => {
      const visible = document.visibilityState === "visible" && !blastModeCovering();
      const baseline = visible ? session : null;
      const view = visible && live ? getActivityView() : null;
      const now = Date.now();
      setState((previous) => acceptPrices(previous, priceCoins, frame, baseline, view, now));
    };
    document.addEventListener("visibilitychange", reset);
    const offUncover = onUncover(reset);
    const subscription = tabMarketStream()?.subscribe({
      pools: [],
      priceCoins,
      expected: null,
      listener: {
        state: (phase) => {
          live = phase === "live";
          if (!live) reset();
        },
        prices: receive,
      },
    });
    return () => {
      subscription?.stop();
      document.removeEventListener("visibilitychange", reset);
      offUncover();
    };
  }, [subscriptionKey]);

  return { latest: state.latest, move: state.move?.scope === activityScope ? state.move ?? null : null };
}

function acceptPrices(
  previous: PriceState,
  priceCoins: readonly string[],
  { checkpoint, prices }: DisplayPriceFrame,
  session: object | null,
  view: ActivityView | null,
  now: number,
): PriceState {
  const latest = new Map(priceCoins.flatMap((type) => {
    const price = previous.latest.get(type);
    return price ? [[type, price] as const] : [];
  }));
  let changed = latest.size !== previous.latest.size;
  let best: HomePriceMove | null = null;
  const canCue = now - (previous.move?.seenAtMs ?? -Infinity) >= HOME_PRICE_MOVE_CUE_GAP_MS;
  for (const price of prices) {
    const current = latest.get(price.coin_type);
    if (current && (checkpoint < current.checkpoint || price.as_of_ms < current.as_of_ms)) continue;
    const observation = { ...price, checkpoint, session };
    latest.set(price.coin_type, observation);
    changed = true;
    if (!view || !canCue || !session || !current || current.session !== session) continue;
    const move = marketMove(view, current, observation, now);
    if (move && (!best || Math.abs(move.bps) > Math.abs(best.bps))) best = move;
  }
  return changed ? { latest, move: best ?? previous.move } : previous;
}

function marketMove(view: ActivityView, previous: Observation, price: Observation, now: number): HomePriceMove | null {
  if (price.as_of_ms <= previous.as_of_ms || now - price.as_of_ms > HOME_PRICE_MOVE_FRESH_MS) return null;
  const from = Number(previous.usd_price);
  const to = Number(price.usd_price);
  const bps = Math.round((to / from - 1) * 10_000);
  if (from <= 0 || to <= 0 || !Number.isFinite(bps) || Math.abs(bps) < HOME_PRICE_MOVE_MIN_BPS) return null;
  const coin = view.coins.find((row) => row.lifecycle === "migrated" && coinKey(row.coin_type) === price.coin_type);
  if (!coin) return null;
  const checkpoint = coin.readCheckpoint ?? view.scope.checkpoint;
  if (!isNewerHomePrice(price, coin, checkpoint)) return null;
  if (!isNewerHomePrice(previous, coin, checkpoint) && Number(coin.price_usd) !== from) return null;
  return { coin, bps, seenAtMs: now, scope: view.scope };
}

/** A timestamp tie can only be broken by the market watermark read alongside the HTTP price. */
export function newerHomePrice(
  latest: ReadonlyMap<string, StampedPrice>,
  coin: HomeCoin,
  checkpoint: number,
): DisplayPrice | undefined {
  if (coin.lifecycle !== "migrated" || !latest.size) return undefined;
  const type = coinKey(coin.coin_type);
  const price = type ? latest.get(type) : undefined;
  return price && isNewerHomePrice(price, coin, checkpoint) ? price : undefined;
}

function isNewerHomePrice(price: StampedPrice, coin: HomeCoin, checkpoint: number): boolean {
  const marketCheckpoint = coin.live_inputs?.price_checkpoint;
  if (price.checkpoint < (marketCheckpoint ?? checkpoint)) return false;
  const asOf = coin.price_as_of_ms ?? 0;
  if (price.as_of_ms === asOf) {
    return marketCheckpoint !== undefined && price.checkpoint > marketCheckpoint;
  }
  return price.as_of_ms > asOf;
}
