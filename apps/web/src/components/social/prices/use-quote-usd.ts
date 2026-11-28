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

/** A quote coin's rate on the tab's stream: its latest fresh dollar price, and whether the stream is live. */
type StreamedRate = Readonly<{ usd: string | null; live: boolean }>;

type Entry = {
  readers: number;
  rate: StreamedRate;
  notify: Set<() => void>;
  subscription: MarketStreamSubscription | undefined;
  expiry: ReturnType<typeof setTimeout> | null;
};

const NONE: StreamedRate = { usd: null, live: false };
const entries = new Map<string, Entry>();

function publish(entry: Entry, rate: StreamedRate): void {
  if (rate.usd === entry.rate.usd && rate.live === entry.rate.live) return;
  entry.rate = rate;
  for (const notify of entry.notify) notify();
}

/** One hub subscription per quote coin for the whole tab, however many screens read its rate. */
function join(coin: string, notify: () => void): () => void {
  let entry = entries.get(coin);
  if (!entry) {
    const created: Entry = { readers: 0, rate: NONE, notify: new Set(), subscription: undefined, expiry: null };
    const prices = ({ prices: observed }: DisplayPriceFrame) => {
      const price = observed.find((each) => each.coin_type === coin);
      if (!price || !(Number(price.usd_price) > 0)) return;
      if (created.expiry) clearTimeout(created.expiry);
      // The poll's freshness rule: a price older than the portfolio's limit is no rate.
      const left = Math.min(PORTFOLIO_PRICE_MAX_AGE_MS, price.as_of_ms + PORTFOLIO_PRICE_MAX_AGE_MS - Date.now());
      created.expiry = left > 0 ? setTimeout(() => publish(created, { ...created.rate, usd: null }), left) : null;
      if (left > 0) publish(created, { ...created.rate, usd: price.usd_price });
    };
    created.subscription = tabMarketStream()?.subscribe({
      pools: [],
      priceCoins: [coin],
      expected: null,
      listener: { state: (state) => publish(created, { ...created.rate, live: state === "live" }), prices },
    });
    entries.set(coin, (entry = created));
  }
  const joined = entry;
  joined.readers += 1;
  joined.notify.add(notify);
  return () => {
    joined.notify.delete(notify);
    joined.readers -= 1;
    if (joined.readers > 0) return;
    if (joined.expiry) clearTimeout(joined.expiry);
    joined.subscription?.stop();
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

/**
 * Current FX. Display values use USDC at par by default. `live` (a coin page, whose numbers move with
 * its stream) follows the quote coin's `prices` entry on the tab's stream instead: SUI, and USDC from
 * Pyth, so a pool price times the rate moves on each tick. Only Create's quote coins stream, one
 * subscription each per tab; the 60 s read stands in while the stream has no fresh rate. USDC keeps par
 * until its first streamed rate, so a page never flips between dollars and USDC.
 */
export function useQuoteUsd(quoteType: string | null, { marketRate = false, live = false } = {}): string | null {
  const type = quoteType ? quotePriceType(quoteType) : null;
  const par = type === CREATE_QUOTE_TYPE;
  const atPar = par && !marketRate && !live;
  const streamed = useStreamedRate(live && type && createQuoteOf(type) ? coinKey(type) : null);
  const client = useAppQueryClient();
  const { data, isStale } = useQuery({
    ...priceQuery({ kind: "coin", id: type ?? "", window: "1h" }),
    // USDC on a live page reads no fallback: it holds par while the stream is away.
    enabled: !!type && !atPar && !(live && par) && !(streamed.live && streamed.usd),
    staleTime: ({ state }) => {
      const asOf = state.data?.price_as_of_ms;
      if (asOf == null || asOf > state.dataUpdatedAt) return 0;
      return Math.max(0, asOf + PORTFOLIO_PRICE_MAX_AGE_MS - state.dataUpdatedAt);
    },
    notifyOnChangeProps: ["data", "isStale"],
    refetchInterval: (query) => pollInterval(PORTFOLIO_PRICE_MAX_AGE_MS / 2, query),
  }, client);
  if (atPar) return "1";
  if (streamed.usd) return streamed.usd;
  if (live && par) return "1";
  const price = data?.price_usd;
  return !isStale && price && Number(price) > 0 ? price : null;
}
