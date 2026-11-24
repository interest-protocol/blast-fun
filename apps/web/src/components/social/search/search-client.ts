import { responseError, PublicError, responseDiagnostic } from "#web/lib/errors.ts";
import { QueryObserver, type QueryClient, type QueryKey } from "@tanstack/react-query";

import { queryKeys } from "#web/lib/query/keys.ts";
import { normalizeSearchQuery, socialSearchPath, socialSearchResponseSchema, type SocialSearchResponse } from "@blast/core/web/contracts/search.ts";
import { normalizeTradeCoinQuery, SOCIAL_TRADE_COINS_MAX_QUERY, socialTradeCoinsPath, type SocialTradeCoin } from "@blast/core/web/contracts/trades.ts";

import { isValidStructTag } from "@mysten/sui/utils";

import { isTradeCoinPage } from "../coins/swap-client";
import { SEARCH_COINS_LIMIT } from "./search-model";
import { readSaleCoins } from "../coin-home/home-client.ts";
import { withoutTestSearchPresales, withoutTestTradeCoins, type ReadSaleCoins } from "#web/lib/test-launches.ts";

/**
 * The search sheet's read: `GET /api/social/search` for the normalized term
 * (so equal searches share the CDN's answer), without an access token (the
 * answer is public), with a small in-page memory so backspacing over a term
 * shows its answer at once. Answers are kept `MEMORY_MS`, the CDN's life.
 * Given the page's `QueryClient` (OA-38), that memory is the shared cache
 * (`["blast","public","search",term]`), so two readers of one term in flight
 * share one request.
 *
 * OA-41 (R3-82): the Coins group's read beside it, `GET
 * /api/social/trades/coins?q=` (public, CDN-cached, Blast launches and ecosystem coins
 * whose name or ticker contains the term), kept the same way under
 * `[…search, term, "coins"]`. A failure lists no launch coins (SUI still shows).
 *
 * Both groups leave out test sales (lib/test-launches.ts), looked up by id
 * through `saleCoins`; a complete coin type stays unfiltered.
 */
const MEMORY_MS = 10_000;
const MEMORY_MAX = 50;

export type SearchFetch = typeof globalThis.fetch;

export function isSearchResponse(value: unknown): value is SocialSearchResponse {
  return socialSearchResponseSchema.safeParse(value).success;
}

export function createSearchClient(
  fetcher: SearchFetch = (input, init) => globalThis.fetch(input, init),
  clock: () => number = Date.now,
  cache?: QueryClient,
  saleCoins: ReadSaleCoins = readSaleCoins,
) {
  const memory = new Map<string, { at: number; answer: SocialSearchResponse }>();
  const coinMemory = new Map<string, { at: number; coins: readonly SocialTradeCoin[] }>();
  const failures = new Map<string, unknown>();
  return {
    failure(raw: string): unknown {
      const term = normalizeSearchQuery(raw);
      const coin = coinTerm(raw);
      return (term === null ? undefined : cache?.getQueryState(queryKeys.search(term))?.error)
        ?? (coin === null ? undefined : cache?.getQueryState(coinsKey(coin))?.error)
        ?? (term === null ? null : failures.get(term));
    },
    /** The answer already in memory for `raw`, if fresh. */
    remembered(raw: string): SocialSearchResponse | null {
      const term = normalizeSearchQuery(raw);
      if (term === null) return null;
      if (cache) {
        const state = cache.getQueryState<SocialSearchResponse | null>(queryKeys.search(term));
        return state?.data && clock() - state.dataUpdatedAt < MEMORY_MS ? state.data : null;
      }
      const hit = memory.get(term);
      return hit && clock() - hit.at < MEMORY_MS ? hit.answer : null;
    },
    /** Reads `raw`'s answer; null on any failure (the sheet offers Try again). A too-long term reads as nothing found. */
    async search(raw: string, signal?: AbortSignal): Promise<SocialSearchResponse | null> {
      const term = normalizeSearchQuery(raw);
      if (term === null || signal?.aborted) return null;
      const fresh = this.remembered(term);
      if (fresh) return fresh;
      if (cache) {
        // A failed read is null (the sheet offers Try again), never cached as an answer.
        return readShared(cache, queryKeys.search(term), (signal) => readTerm(term, signal), signal)
          .catch(() => null);
      }
      try {
        const body = await readTerm(term, signal);
        if (signal?.aborted) return null;
        failures.delete(term);
        memory.set(term, { at: clock(), answer: body });
        if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
        return body;
      } catch (error) {
        if (signal?.aborted) return null;
        failures.set(term, error);
        if (failures.size > MEMORY_MAX) failures.delete(failures.keys().next().value as string);
        return null;
      }
    },
    /** The sale coins already in memory for `raw`, if fresh. */
    rememberedCoins(raw: string): readonly SocialTradeCoin[] | null {
      const term = coinTerm(raw);
      if (term === null) return [];
      if (cache) {
        const state = cache.getQueryState<readonly SocialTradeCoin[]>(coinsKey(term));
        return state?.data && clock() - state.dataUpdatedAt < MEMORY_MS ? state.data : null;
      }
      const hit = coinMemory.get(term);
      return hit && clock() - hit.at < MEMORY_MS ? hit.coins : null;
    },
    /** Reads the sale coins for `raw` (at most the group's five); none on any failure or a term the route cannot read. */
    async coins(raw: string, signal?: AbortSignal): Promise<readonly SocialTradeCoin[]> {
      const term = coinTerm(raw);
      if (term === null || signal?.aborted) return [];
      const fresh = this.rememberedCoins(raw);
      if (fresh) return fresh;
      if (cache) {
        return readShared(cache, coinsKey(term), (signal) => readCoins(term, signal), signal)
          .catch(() => []);
      }
      try {
        const coins = await readCoins(term, signal);
        if (signal?.aborted) return [];
        coinMemory.set(term, { at: clock(), coins });
        if (coinMemory.size > MEMORY_MAX) coinMemory.delete(coinMemory.keys().next().value as string);
        return coins;
      } catch {
        return [];
      }
    },
  };

  /** The Coins group for `term` ("" lists the first coins); a throw on any failure. */
  async function readCoins(term: string, signal?: AbortSignal): Promise<readonly SocialTradeCoin[]> {
    const page = await readCoinPage(term, signal);
    // A complete coin type is an exact lookup and stays unfiltered, as in the pickers.
    return (isValidStructTag(term) ? page : await withoutTestTradeCoins(page, saleCoins)).coins;
  }

  async function readCoinPage(term: string, signal?: AbortSignal) {
    const path = socialTradeCoinsPath({ q: term || null, limit: SEARCH_COINS_LIMIT, includeLaunch: term !== "" });
    const response = await fetcher(path, { credentials: "same-origin", signal, headers: { accept: "application/json" } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw responseError(body, response);
    if (!isTradeCoinPage(body)) throw new PublicError("Search returned an unreadable response. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
    return body;
  }

  /** One read of `term` for the cache: the answer, or a throw (so a failure is not kept). */
  async function readTerm(term: string, signal?: AbortSignal): Promise<SocialSearchResponse> {
    const response = await fetcher(socialSearchPath(term), { credentials: "same-origin", signal, headers: { accept: "application/json" } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw responseError(body, response);
    if (!isSearchResponse(body)) throw new PublicError("Search returned an unreadable response. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
    return withoutTestSearchPresales(body, saleCoins);
  }
}

/** Each caller observes the shared query until it finishes or leaves; the last departure aborts its fetch. */
async function readShared<Answer>(cache: QueryClient, queryKey: QueryKey, read: (signal: AbortSignal) => Promise<Answer>, signal?: AbortSignal): Promise<Answer> {
  signal?.throwIfAborted();
  const observer = new QueryObserver(cache, {
    queryKey,
    queryFn: ({ signal }) => read(signal),
    staleTime: MEMORY_MS,
    retry: false,
  });
  let abort: () => void = () => {};
  try {
    return await new Promise<Answer>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const settle = () => {
        const result = observer.getCurrentResult();
        if (result.fetchStatus !== "idle") return;
        if (result.isSuccess) resolve(result.data);
        else if (result.isError) reject(result.error);
      };
      observer.subscribe(settle);
      settle();
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    observer.destroy();
  }
}

/** A complete coin type uses the trade lookup's canonical form and length limit. */
export function exactCoinSearchTerm(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\$/, "").trim();
  if (trimmed.length > SOCIAL_TRADE_COINS_MAX_QUERY || !isValidStructTag(trimmed)) return null;
  const coinType = normalizeTradeCoinQuery(trimmed);
  return coinType.length <= SOCIAL_TRADE_COINS_MAX_QUERY ? coinType : trimmed;
}

function coinTerm(raw: string): string | null {
  return exactCoinSearchTerm(raw) ?? normalizeSearchQuery(raw);
}

const coinsKey = (term: string) => [...queryKeys.search(term), "coins"] as const;

export type SearchClient = ReturnType<typeof createSearchClient>;
