"use client";

import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { PUBLIC_STALE_MS, QueryTransientError } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import {
  PRICE_DEFAULT_POINTS,
  PRICE_WINDOWS,
  PRICE_MAX_COINS,
  PRICE_MAX_PRESALES,
  socialPricesPath,
  socialPricesResponseSchema,
  type PriceWindow,
  type PriceTier,
  type SocialPriceHistory,
  type SocialPricesResponse,
} from "@blast/core/web/contracts/prices.ts";

import type { SparkPoint } from "#web/components/charts/spark-model.ts";

/**
 * The browser's reads of `GET /api/social/prices` (R3-20, contract in
 * `contracts/prices.ts`): public and CDN-cached, so no access token goes
 * with them (only the API gate cookie). Every surface that draws a coin's line asks through `loadPrice`,
 * which gathers the asks made in the same tick into one request per window
 * (a feed page's call cards, a profile's calls). Each answer is a shared query
 * (OA-38, `["blast","public","prices","history",…]`) kept fresh for the
 * route's shared-cache life, so a card mounted again, or a second card for the
 * same sale, asks nothing. A failure reads as "no history": the slot stays
 * empty, never a made-up line, and is not kept (the next mount asks again).
 */

/** One page of prices, or null on any failure. */
export async function fetchPrices(
  query: Readonly<{ presales?: readonly string[]; coins?: readonly string[]; window?: PriceWindow; points?: number; interval?: PriceTier }>,
  signal?: AbortSignal,
): Promise<SocialPricesResponse | null> {
  try {
    const response = await fetch(socialPricesPath(query), { credentials: "same-origin", signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const parsed = socialPricesResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The answers keyed as asked: a sale by its id, a coin by its type. */
export function pricesByKey(response: SocialPricesResponse | null): ReadonlyMap<string, SocialPriceHistory> {
  return new Map((response?.prices ?? []).map((price) => [price.presale_id ?? price.coin_type, price]));
}

/** A series as numbers for a chart: `[ms, usd]`, or null when there is no line. */
export function sparkOf(price: SocialPriceHistory | null | undefined): readonly SparkPoint[] | null {
  if (!price || price.points.length < 2) return null;
  return price.points.map(([at, usd]) => [at, Number(usd)] as const);
}

/** The route's shared-cache life: an answer younger than this is reused. */
export const PRICE_REUSE_MS = 10_000;

type Ask = Readonly<{ kind: "presale" | "coin"; id: string; window: PriceWindow }>;
type Waiter = Readonly<{ resolve: (price: SocialPriceHistory | null) => void; reject: (error: Error) => void }>;

const keyOf = (ask: Ask) => `${ask.window}:${ask.kind}:${ask.id}`;
const queued = new Map<string, { ask: Ask; waiters: Waiter[] }>();
let flushing: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  flushing = null;
  const asks = [...queued.values()];
  queued.clear();
  for (const window of PRICE_WINDOWS) {
    const presales = asks.filter((entry) => entry.ask.window === window && entry.ask.kind === "presale");
    const coins = asks.filter((entry) => entry.ask.window === window && entry.ask.kind === "coin");
    const batches: (typeof asks)[] = [];
    for (let index = 0; index < presales.length; index += PRICE_MAX_PRESALES) batches.push(presales.slice(index, index + PRICE_MAX_PRESALES));
    for (let index = 0; index < coins.length; index += PRICE_MAX_COINS) batches.push(coins.slice(index, index + PRICE_MAX_COINS));
    for (const batch of batches) {
      void fetchPrices({
        presales: batch.filter((entry) => entry.ask.kind === "presale").map((entry) => entry.ask.id),
        coins: batch.filter((entry) => entry.ask.kind === "coin").map((entry) => entry.ask.id),
        window,
        points: PRICE_DEFAULT_POINTS,
      }).then((response) => {
        const found = pricesByKey(response);
        for (const entry of batch) {
          // A failed read rejects, so the cache keeps nothing and the next mount asks again.
          for (const waiter of entry.waiters) {
            if (response === null) waiter.reject(new QueryTransientError("The prices did not answer."));
            else waiter.resolve(found.get(entry.ask.id) ?? null);
          }
        }
      });
    }
  }
}

/**
 * The last 24 hours of a set of sales (`ids`, comma-joined as one key), read at
 * once: Blast mode's trading cards and the feed's "why now" line share it, so
 * either one's read serves the other. A failed read rejects (nothing is kept;
 * the next look asks again).
 */
export function salesPricesQuery(ids: string) {
  return queryOptions({
    queryKey: queryKeys.prices.batch("24h", ids),
    queryFn: async () => {
      const answer = await fetchPrices({ presales: ids.split(","), window: "24h" });
      if (answer === null) throw new QueryTransientError("The prices did not answer.");
      return answer;
    },
    staleTime: PUBLIC_STALE_MS,
    // A failed read waits for the next look (no retry of its own).
    retry: false,
  });
}

/** One sale's or coin's prices over `window`, gathered with the other asks of this tick; rejects when the read failed. */
export function loadPrice(ask: Ask): Promise<SocialPriceHistory | null> {
  const key = keyOf(ask);
  return new Promise((resolve, reject) => {
    const entry = queued.get(key) ?? { ask, waiters: [] };
    entry.waiters.push({ resolve, reject });
    queued.set(key, entry);
    flushing ??= setTimeout(flush, 0);
  });
}

/** One sale's or coin's prices as a shared query: the batch loader is its read, the route's cache life its freshness. */
export function priceQuery(ask: Ask) {
  return queryOptions({
    queryKey: queryKeys.prices.history(`${ask.kind}:${ask.id}`, ask.window),
    queryFn: () => loadPrice(ask),
    staleTime: PRICE_REUSE_MS,
    // "No history" on a failure, as before; the next mount asks again.
    retry: false,
  });
}

/**
 * A sale's (or a coin's) prices over `window`, read after the page is the
 * browser's: undefined while reading, null when there is no history.
 * `refresh` reads again when it changes (a live look).
 */
export function usePrice(
  ask: Readonly<{ presaleId?: string | null; coin?: string | null; window?: PriceWindow }> | null,
  refresh: unknown = 0,
): SocialPriceHistory | null | undefined {
  const kind = ask?.presaleId ? "presale" : ask?.coin ? "coin" : null;
  const id = ask?.presaleId ?? ask?.coin ?? null;
  const window = ask?.window ?? "24h";
  const client = useAppQueryClient();
  const query = useQuery({ ...priceQuery({ kind: kind ?? "presale", id: id ?? "", window }), enabled: kind !== null && id !== null }, client);
  // `refresh` changing (a live look) reads it again; its first value is the mount's own read.
  const seen = useRef(refresh);
  useEffect(() => {
    if (Object.is(seen.current, refresh)) return;
    seen.current = refresh;
    if (kind === null || id === null) return;
    void client.invalidateQueries({ queryKey: queryKeys.prices.history(`${kind}:${id}`, window), exact: true }, { cancelRefetch: false });
  }, [client, kind, id, window, refresh]);
  if (kind === null || id === null) return null;
  if (query.data !== undefined) return query.data;
  return query.isError ? null : undefined;
}
