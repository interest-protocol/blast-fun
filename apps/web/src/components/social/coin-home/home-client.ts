import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { PUBLIC_STALE_MS, QueryTransientError, VIEWER_STALE_MS, unwrapApiResult } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import {
  HOME_DEFAULT_WINDOW,
  HOME_TRADERS_DEFAULT_QUERY,
  type HomeTradersQuery,
  SOCIAL_HOME_FOLLOWING_PATH,
  socialHomeActivityPath,
  socialHomeCoinsPath,
  socialHomeDiscussionPath,
  socialHomePath,
  socialHomeTradersPath,
  withHomeDiscoverDetails,
  withHomeMarketDetails,
  type HomeCoinsByIds,
  type HomeCoinsPage,
  type HomeDiscussionPage,
  type HomeFollowingRequest,
  type HomeFollowingResponse,
  type HomeQuery,
  type HomeThreadPage,
  type HomeTradersPage,
  type HomeWindow,
} from "@blast/core/web/contracts/home.ts";

import { homeCoinsPageReadSchema, homeCoinsByIdsReadSchema, homeThreadPageReadSchema, homeTradersPageReadSchema, homeFollowingReadSchema } from "@blast/core/web/contracts/home-read-schemas.ts";
import { homeDiscussionPageSchema } from "@blast/core/web/contracts/home-schemas.ts";

import { marketReadPolicy, retainMarketValues } from "./market-refresh";
import { publicJson, publicReadSignal } from "../public-json.ts";
import { callSocialApi, type SocialResponseBody, type SocialApiOptions } from "../social-api.ts";
import type { AccessTokenSource } from "../social-fetch";
import { withoutTestCoins } from "#web/lib/test-launches.ts";

/**
 * Home's browser reads as TanStack Query options (OA-38): the public ones
 * without credentials (CDN-cached, the same for everyone), the Following
 * ones through `callSocialApi` (OA-16) under the viewer's scope. A refusal
 * throws `QueryRefusal` (never retried); a network failure or an unreadable
 * body `QueryTransientError` (retried with backoff).
 */
function readHomeJson<Body>(path: string, what: string, contract: SocialResponseBody<Body>, signal?: AbortSignal): Promise<Body> {
  return publicJson(path, what, contract, {
    signal: publicReadSignal(signal),
    networkError: () => new QueryTransientError(`${what} did not answer. Check your connection and try again.`),
  });
}

export function fetchHomePage(query: HomeQuery, cursor: string | null, signal?: AbortSignal, marketDetails = false): Promise<HomeCoinsPage> {
  const path = socialHomePath({ ...query, cursor });
  return readHomeJson<HomeCoinsPage>(marketDetails ? withHomeDiscoverDetails(path) : path, "The coins", homeCoinsPageReadSchema, signal);
}

/** How long the test-sale lookup may take before the rows waiting on it show unfiltered. */
const SALE_LOOKUP_MS = 3_000;

/**
 * The by-ids read the test-sale lookup uses (lib/test-launches.ts): one holder
 * per coin, the lightest answer. Readers share it while it is in flight, so it
 * ends only on `SALE_LOOKUP_MS`, never on one reader leaving.
 */
export async function readSaleCoins(ids: readonly string[]) {
  return (await fetchHomeCoins(ids, HOME_DEFAULT_WINDOW, AbortSignal.timeout(SALE_LOOKUP_MS), 1)).coins;
}

export function fetchHomeCoins(presaleIds: readonly string[], window: HomeWindow, signal?: AbortSignal, holderLimit?: number, marketDetails = false): Promise<HomeCoinsByIds> {
  const path = socialHomeCoinsPath(presaleIds, window, holderLimit);
  return readHomeJson<HomeCoinsByIds>(marketDetails ? withHomeMarketDetails(path) : path, "Your watchlist's coins", homeCoinsByIdsReadSchema, signal);
}

export function fetchHomeTraders(window: HomeWindow, signal?: AbortSignal, query: HomeTradersQuery = HOME_TRADERS_DEFAULT_QUERY): Promise<HomeTradersPage> {
  return readHomeJson<HomeTradersPage>(socialHomeTradersPath(window, query), "The traders", homeTradersPageReadSchema, signal);
}

/** One coin's thread by its key (`homeCoinKey`): a presale id or a curve coin's type. */
export function fetchHomeThread(coinKey: string, window: HomeWindow, cursor: string | null, signal?: AbortSignal, at?: number): Promise<HomeThreadPage> {
  return readHomeJson<HomeThreadPage>(socialHomeActivityPath(coinKey, window, cursor, at), "The activity", homeThreadPageReadSchema, signal);
}

export function fetchHomeDiscussion(presaleId: string, cursor: string | null, signal?: AbortSignal): Promise<HomeDiscussionPage> {
  return readHomeJson<HomeDiscussionPage>(socialHomeDiscussionPath(presaleId, cursor), "The discussion", homeDiscussionPageSchema, signal);
}

/** One Following read with the viewer's credentials; the result as `callSocialApi` answers it. */
export function fetchHomeFollowing(options: SocialApiOptions, body: HomeFollowingRequest, marketDetails = false) {
  const path = marketDetails ? withHomeMarketDetails(SOCIAL_HOME_FOLLOWING_PATH) : SOCIAL_HOME_FOLLOWING_PATH;
  return callSocialApi<HomeFollowingResponse>(options, path, { method: "POST", body }, homeFollowingReadSchema);
}

/* ---------------- Query options ---------------- */

/**
 * One Discover page, keyed by the query string (the page and the rows per
 * page included). Nothing refetches it behind the reader (`staleTime:
 * "static"`): Home refreshes on its own gate. While the next page loads the
 * previous one stays on screen (`keepPreviousData`), so nothing jumps.
 */
export function discoverQuery(query: HomeQuery, marketDetails = false) {
  const path = socialHomePath(query);
  const key = marketDetails ? withHomeDiscoverDetails(path) : path;
  return queryOptions({
    queryKey: queryKeys.home.discover(key),
    queryFn: async ({ signal }): Promise<HomeCoinsPage> => withoutTestCoins(await fetchHomePage(query, null, signal, marketDetails)),
    placeholderData: keepPreviousData,
    staleTime: "static",
    ...marketReadPolicy,
    structuralSharing: (old, next) => retainMarketValues(old, next as HomeCoinsPage),
  });
}

/** The Watchlist's items by their saved ids (at most 50 per read; the page chunks). */
export function coinsByIdsQuery(presaleIds: readonly string[], window: HomeWindow, holderLimit?: number, marketDetails = false) {
  const key = queryKeys.home.coins(window, presaleIds, holderLimit);
  return queryOptions({
    queryKey: marketDetails ? [...key, "rolling_market_details"] : key,
    queryFn: ({ signal }) => fetchHomeCoins(presaleIds, window, signal, holderLimit, marketDetails),
    staleTime: PUBLIC_STALE_MS,
    ...marketReadPolicy,
    structuralSharing: (old, next) => retainMarketValues(old, next as HomeCoinsByIds),
    enabled: presaleIds.length > 0,
  });
}

/** Global PnL since launch, searched and paginated by the server. */
export function tradersQuery(window: HomeWindow, query: HomeTradersQuery = HOME_TRADERS_DEFAULT_QUERY) {
  return queryOptions({
    queryKey: queryKeys.home.traders(socialHomeTradersPath(window, query)),
    queryFn: ({ signal }) => fetchHomeTraders(window, signal, query),
    placeholderData: keepPreviousData,
    staleTime: PUBLIC_STALE_MS,
  });
}

/** One coin's thread in the pool scope, paged by participant. */
export function threadQuery(coinKey: string, window: HomeWindow) {
  return infiniteQueryOptions({
    queryKey: queryKeys.home.thread(coinKey, window),
    queryFn: ({ pageParam, signal }) => fetchHomeThread(coinKey, window, pageParam, signal),
    gcTime: 30 * 60_000,
    initialPageParam: null as string | null,
    getNextPageParam: (last: HomeThreadPage) => last.next_cursor,
    staleTime: PUBLIC_STALE_MS,
  });
}

/** One coin's discussion: its posts with a why, paged. */
export function discussionQuery(presaleId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.home.discussion(presaleId),
    queryFn: ({ pageParam, signal }) => fetchHomeDiscussion(presaleId, pageParam, signal),
    gcTime: 30 * 60_000,
    initialPageParam: null as string | null,
    getNextPageParam: (last: HomeDiscussionPage) => last.next_cursor,
    staleTime: PUBLIC_STALE_MS,
  });
}

type Token = AccessTokenSource;

type FollowingCoins = Extract<HomeFollowingResponse, { mode: "coins" }>;
type FollowingPreview = Extract<HomeFollowingResponse, { mode: "preview" }>;
type FollowingTape = Extract<HomeFollowingResponse, { mode: "tape" }>;

async function followingRead<Mode extends HomeFollowingResponse["mode"]>(getAccessToken: Token, body: HomeFollowingRequest, mode: Mode, signal?: AbortSignal, marketDetails = false): Promise<Extract<HomeFollowingResponse, { mode: Mode }>> {
  const answer = unwrapApiResult(await fetchHomeFollowing({ getAccessToken, signal }, body, marketDetails));
  if (answer.mode !== mode) throw new QueryTransientError("The Following read returned an unreadable response. Try again.", null, undefined, "invalid_response");
  return answer as Extract<HomeFollowingResponse, { mode: Mode }>;
}

/** The viewer's Following source: every coin a followed account touched in the window, one page at a time. */
export function followingCoinsQuery(getAccessToken: Token, scope: string, window: HomeWindow, page: number, limit: number, marketDetails = false) {
  const key = queryKeys.me.home.following(scope, window, page, limit);
  return queryOptions({
    queryKey: marketDetails ? [...key, "rolling_market_details"] : key,
    queryFn: ({ signal }): Promise<FollowingCoins> => followingRead(getAccessToken, { mode: "coins", window, page, limit }, "coins", signal, marketDetails),
    placeholderData: keepPreviousData,
    staleTime: VIEWER_STALE_MS,
    ...marketReadPolicy,
    structuralSharing: (old, next) => retainMarketValues(old, next as FollowingCoins),
  });
}

/** The followed participation of the sales on screen, in one read per batch. */
export function followingPreviewQuery(getAccessToken: Token, scope: string, window: HomeWindow, presaleIds: readonly string[]) {
  return queryOptions({
    queryKey: queryKeys.me.home.preview(scope, window, presaleIds),
    queryFn: ({ signal }): Promise<FollowingPreview> => followingRead(getAccessToken, { mode: "preview", window, presale_ids: presaleIds }, "preview", signal),
    staleTime: VIEWER_STALE_MS,
    enabled: presaleIds.length > 0,
  });
}

/** The tape: the newest events by people the viewer follows, across every coin. */
export function followingTapeQuery(getAccessToken: Token, scope: string, window: HomeWindow) {
  return queryOptions({
    queryKey: queryKeys.me.home.tape(scope, window),
    queryFn: ({ signal }): Promise<FollowingTape> => followingRead(getAccessToken, { mode: "tape", window }, "tape", signal),
    staleTime: VIEWER_STALE_MS,
  });
}
