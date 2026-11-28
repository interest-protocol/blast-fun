"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { CREATE_QUOTE_TYPE, createQuoteOf, quotePriceType } from "@blast/core/web/contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/web/contracts/portfolio.ts";
import type { DisplayPriceFrame } from "@blast/core/modules/launchpad-contract/market-stream.ts";

import { coinKey, tabMarketStream, type MarketStreamSubscription } from "#web/components/launchpad/market-stream-hub.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { priceQuery } from "./price-client.ts";

/**
 * A quote coin's rate on the tab's stream: its latest dollar price, whether that price is still inside the
 * freshness limit, and whether the stream is live.
 */
type StreamedRate = Readonly<{ usd: string | null; fresh: boolean; live: boolean }>;

type Entry = {
  readers: number;
  rate: StreamedRate;
  notify: Set<() => void>;
  subscription: MarketStreamSubscription | undefined;
  expiry: ReturnType<typeof setTimeout> | null;
};

const NONE: StreamedRate = { usd: null, fresh: false, live: false };
const entries = new Map<string, Entry>();

function publish(entry: Entry, rate: StreamedRate): void {
  if (rate.usd === entry.rate.usd && rate.fresh === entry.rate.fresh && rate.live === entry.rate.live) return;
  entry.rate = rate;
  for (const notify of entry.notify) notify();
}

/** How long a streamed price stays a rate: the poll's freshness rule, so an old price is no rate. */
function freshFor(asOfMs: number): number {
  return Math.min(PORTFOLIO_PRICE_MAX_AGE_MS, asOfMs + PORTFOLIO_PRICE_MAX_AGE_MS - Date.now());
}

/** Takes the coin's price from a frame; it ages out unless a newer one comes, and stays as the last streamed stand-in. */
function takePrice(entry: Entry, coin: string, { prices }: DisplayPriceFrame): void {
  const price = prices.find((each) => each.coin_type === coin);
  if (!price || !(Number(price.usd_price) > 0)) return;
  const left = freshFor(price.as_of_ms);
  if (left <= 0) return;
  if (entry.expiry) clearTimeout(entry.expiry);
  entry.expiry = setTimeout(() => publish(entry, { ...entry.rate, fresh: false }), left);
  publish(entry, { ...entry.rate, usd: price.usd_price, fresh: true });
}

function open(coin: string): Entry {
  const entry: Entry = { readers: 0, rate: NONE, notify: new Set(), subscription: undefined, expiry: null };
  entry.subscription = tabMarketStream()?.subscribe({
    pools: [],
    priceCoins: [coin],
    expected: null,
    listener: {
      state: (state) => publish(entry, { ...entry.rate, live: state === "live" }),
      prices: (frame) => takePrice(entry, coin, frame),
    },
  });
  entries.set(coin, entry);
  return entry;
}

/** One hub subscription per quote coin for the whole tab, however many screens read its rate. */
function join(coin: string, notify: () => void): () => void {
  const entry = entries.get(coin) ?? open(coin);
  entry.readers += 1;
  entry.notify.add(notify);
  return () => {
    entry.notify.delete(notify);
    entry.readers -= 1;
    if (entry.readers > 0) return;
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.subscription?.stop();
    entries.delete(coin);
  };
}

function useStreamedRate(coin: string | null): StreamedRate {
  const subscribe = useCallback((notify: () => void) => (coin ? join(coin, notify) : () => {}), [coin]);
  return useSyncExternalStore(
    subscribe,
    () => (coin ? entries.get(coin)?.rate ?? NONE : NONE),
    () => NONE,
  );
}

/** The stream's price while it is live and fresh; the read rests only then. */
function currentRate(rate: StreamedRate): string | null {
  return rate.live && rate.fresh ? rate.usd : null;
}

/** The read's price while it is inside the freshness limit. */
function freshRead(price: string | null | undefined, isStale: boolean): string | null {
  return !isStale && price && Number(price) > 0 ? price : null;
}

/**
 * One rule for a live page: the stream's fresh rate, else the read, else the last streamed rate, else par for
 * USDC. A page off the stream uses par for USDC and the read for SUI.
 */
function chooseRate(atPar: boolean, liveUsdc: boolean, streamed: StreamedRate, read: string | null): string | null {
  if (atPar) return "1";
  return currentRate(streamed) ?? read ?? streamed.usd ?? (liveUsdc ? "1" : null);
}

/** The read's fresh price, and whether its first answer is still on the way (no price, no failure yet). */
function useFallbackRead(type: string | null, enabled: boolean): Readonly<{ price: string | null; pending: boolean }> {
  const { data, isStale, isPending } = useQuery({
    ...priceQuery({ kind: "coin", id: type ?? "", window: "1h" }),
    enabled: !!type && enabled,
    staleTime: ({ state }) => {
      const asOf = state.data?.price_as_of_ms;
      if (asOf == null || asOf > state.dataUpdatedAt) return 0;
      return Math.max(0, asOf + PORTFOLIO_PRICE_MAX_AGE_MS - state.dataUpdatedAt);
    },
    notifyOnChangeProps: ["data", "isStale", "status"],
    refetchInterval: (query) => pollInterval(PORTFOLIO_PRICE_MAX_AGE_MS / 2, query),
  }, useAppQueryClient());
  return { price: freshRead(data?.price_usd, isStale), pending: !!type && enabled && isPending };
}

/** A quote coin's dollar rate, and whether it is still being read: a page can hold its dollar view instead of showing the quote coin first. */
export type QuoteUsdState = Readonly<{ rate: string | null; pending: boolean }>;

/**
 * Current FX. Display values use USDC at par by default. `live` (a coin page, whose numbers move with
 * its stream) follows the quote coin's `prices` entry on the tab's stream instead: SUI, and USDC from
 * Pyth, so a pool price times the rate moves on each tick. Only Create's quote coins stream, one
 * subscription each per tab. The 60 s read runs whenever the stream has no fresh rate; while it has no
 * price either, the last streamed rate stands in, and USDC falls back to par only when neither exists.
 */
export function useQuoteUsd(quoteType: string | null, options: Readonly<{ marketRate?: boolean; live?: boolean }> = {}): string | null {
  return useQuoteUsdState(quoteType, options).rate;
}

/**
 * The rate with its pending state. `pending` holds only until the first read answers: a failed, empty or stale
 * read ends it with no rate, so the page falls back to the quote coin.
 */
export function useQuoteUsdState(quoteType: string | null, { marketRate = false, live = false }: Readonly<{ marketRate?: boolean; live?: boolean }> = {}): QuoteUsdState {
  const type = quoteType ? quotePriceType(quoteType) : null;
  const par = type === CREATE_QUOTE_TYPE;
  const atPar = par && !marketRate && !live;
  const streamed = useStreamedRate(live && type && createQuoteOf(type) ? coinKey(type) : null);
  const read = useFallbackRead(type, !atPar && !currentRate(streamed));
  const rate = chooseRate(atPar, live && par, streamed, read.price);
  return { rate, pending: rate === null && read.pending };
}
