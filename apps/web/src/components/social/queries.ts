import { pollInterval } from "#web/lib/query/polling.ts";
import {
  socialPresaleListPageSchema,
  socialPresaleRowsSchema,
  socialPresaleViewerResponseSchema,
} from "@blast/core/web/contracts/presale-schemas.ts";
import type { ErrorDiagnostic } from "#web/lib/errors.ts";
import { z } from "zod";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { PUBLIC_STALE_MS, QueryTransientError, VIEWER_STALE_MS, unwrapApiResult } from "#web/lib/query/client.ts";
import { queryKeys, sortedIds } from "#web/lib/query/keys.ts";
import {
  PRESALE_COMMIT_FIELDS_HEADER,
  PRESALE_LIST_SORTS,
  SOCIAL_PRESALE_VIEWER_PATH,
  SOCIAL_CREATED_PRESALES_PATH,
  socialPresaleListPath,
  socialPresalePath,
  type PresaleListStatus,
  type SocialPresaleListPage,
  type SocialPresaleSummary,
  type SocialPresaleViewerRequest,
} from "@blast/core/web/contracts/presales.ts";
import { socialRewardsPath } from "@blast/core/web/contracts/rewards.ts";

import { fetchCreatorCommitment } from "./claim/creator-caps-client";
import { fetchAllowlistLeaf } from "./commit/commit-client";
import { fetchWallet, fetchWalletIdentity } from "./coins/coins-client";
import { fetchUnreadCount } from "./notifications/notifications-client";
import { fetchPortfolio, fetchPortfolioCoins } from "./portfolio-client";
import { fetchMePresales, fetchMutuals, fetchProfileCalls, fetchProfileEdit, fetchPublicPortfolio } from "./profile/profile-client";
import { fetchPnl, fetchPublicPnl } from "./profile/pnl-client";
import { fetchRewardsPage } from "./rewards/rewards-client";
import { publicJson } from "./public-json.ts";
import { callSocialApi, type SocialResponseBody } from "./social-api.ts";
import { fetchSettings } from "./settings/settings-client";
import type { AccessTokenSource } from "./social-fetch";
import { fetchWatchlistKeys, fetchWatchlistPage } from "./watchlist/watchlist-client";
import { readVisiblePage, withoutTestPresalePage, withoutTestPresales } from "#web/lib/test-launches.ts";

/**
 * Every social server read as a TanStack Query option set (OA-38): the key
 * (`#web/lib/query/keys`), the read, and how long it stays fresh. Hooks and
 * stores take these, so two consumers of one read share one request and one
 * cache entry, and a mutation or a `/v1/ws` hint names the same key
 * (`#web/lib/query/invalidate`).
 *
 * The reads themselves are the existing clients': signed-in ones go through
 * `callSocialApi` / `socialRequestAuth` (OA-16, never a hand-built header),
 * public ones without credentials. A refusal or a `4xx` throws
 * `QueryRefusal` (never retried); a network failure, a `5xx` or a body that
 * does not parse throws `QueryTransientError` (retried twice with backoff).
 *
 * No read consumes the query's abort signal: a component that unmounts
 * mid-read (React's development double mount, a sheet closing) leaves the
 * read to finish into the cache, so the next consumer gets it without a
 * second request.
 */

type Token = AccessTokenSource;

/* ---------------- Public reads (CDN s-maxage=10) ---------------- */

/** A presale list page (`GET /api/social/presales?status=&sort=&limit=`); `null` (any failure) throws so it is retried. */
export function presaleListQuery(query: Readonly<{ status: PresaleListStatus; sort?: string; limit?: number; cursor?: string | null }>) {
  const full = { status: query.status, sort: query.sort ?? PRESALE_LIST_SORTS[query.status][0], limit: query.limit, cursor: query.cursor ?? null };
  return queryOptions({
    queryKey: queryKeys.presales.list(socialPresaleListPath(full)),
    queryFn: async () => {
      const read = (cursor: string | null) => readPresaleJson<SocialPresaleListPage>(socialPresaleListPath({ ...full, cursor }), "The presale list", socialPresaleListPageSchema);
      return readVisiblePage(full.cursor, read, withoutTestPresalePage, (page) => page.presales.length, (page) => page.next_cursor);
    },
    staleTime: PUBLIC_STALE_MS,
  });
}

/** Home's admin pins; polling also catches changes without chain activity. */
export function featuredPresalesQuery() {
  return queryOptions({
    queryKey: queryKeys.presales.list("/api/social/presales/featured"),
    queryFn: async (): Promise<readonly SocialPresaleSummary[]> => {
      const body = await readPresaleJson("/api/social/presales/featured", "Featured presales", socialPresaleRowsSchema);
      return withoutTestPresales(body.presales);
    },
    staleTime: PUBLIC_STALE_MS,
    refetchInterval: (query) => pollInterval(30_000, query),
  });
}

/** Private creator discovery, invalidated with the account’s presale reads. */
export function createdPresalesQuery(getAccessToken: Token) {
  return queryOptions({
    queryKey: queryKeys.me.createdPresales(),
    queryFn: async () => unwrapApiResult(await callSocialApi({ getAccessToken }, SOCIAL_CREATED_PRESALES_PATH, { method: "GET" },
      socialPresaleRowsSchema)),
    staleTime: VIEWER_STALE_MS,
  });
}

/**
 * `GET /api/social/presales/{id}`, the sale's public read, as the body came
 * (a record). Blast mode's panel, the timeline's team unlock and the
 * celebration each read their own part of it, so one request serves all
 * three; each validates what it draws.
 */
const presaleDetailBodySchema = z.record(z.string(), z.unknown());

export function fetchPresaleDetailBody(presaleId: string): Promise<Record<string, unknown>> {
  return readPresaleJson(socialPresalePath(presaleId), "The sale", presaleDetailBodySchema);
}

function readPresaleJson<Body>(path: string, what: string, contract: SocialResponseBody<Body>) {
  return publicJson(path, what, contract, {
    networkError: () => new QueryTransientError(`${what} did not answer.`),
  });
}

export function presaleDetailQuery(presaleId: string) {
  return queryOptions({
    queryKey: queryKeys.presales.detail(presaleId),
    queryFn: () => fetchPresaleDetailBody(presaleId),
    staleTime: PUBLIC_STALE_MS,
  });
}

/** `GET /api/social/profiles/{callsign}/calls` (public). */
export function profileCallsQuery(callsign: string) {
  return queryOptions({
    queryKey: queryKeys.profiles.read(callsign, "calls"),
    queryFn: async () => unwrapPublic(await fetchProfileCalls(callsign)),
    staleTime: PUBLIC_STALE_MS,
  });
}

/** `GET /api/social/profiles/{callsign}/portfolio` (public, only while its owner opened it). */
export function publicPortfolioQuery(callsign: string) {
  return queryOptions({
    queryKey: queryKeys.profiles.read(callsign, "portfolio"),
    queryFn: async () => unwrapPublic(await fetchPublicPortfolio(callsign)),
    staleTime: PUBLIC_STALE_MS,
  });
}

export function profilePnlQuery(getAccessToken: Token, callsign: string, own: boolean) {
  return queryOptions({
    queryKey: own ? queryKeys.me.pnl() : queryKeys.profiles.read(callsign, "pnl"),
    queryFn: async () => unwrapApiResult(await (own ? fetchPnl({ getAccessToken }) : fetchPublicPnl(callsign))),
    staleTime: own ? VIEWER_STALE_MS : PUBLIC_STALE_MS,
    refetchInterval: (query) => pollInterval(60_000, query),
  });
}

function unwrapPublic<Body>(result: (Readonly<{ status: "ok"; body: Body }> | Readonly<{ status: "refused"; code: string }> | Readonly<{ status: "error" }>) & ErrorDiagnostic): Body {
  return unwrapApiResult(result.status === "refused" ? { ...result, retryAfterSeconds: result.retryAfterSeconds ?? null } : result);
}

/* ---------------- The viewer's own reads (private, no-store) ---------------- */

/**
 * `GET /api/social/me/creator-commitment` (LP-16): the account's 32-byte creator commitment as
 * 64 hex digits, minted on its first read. It never changes, so it is read once per viewer.
 */
export function creatorCommitmentQuery(getAccessToken: Token) {
  return queryOptions({
    queryKey: queryKeys.me.creatorCommitment(),
    queryFn: async ({ signal }) => unwrapApiResult(await fetchCreatorCommitment({ getAccessToken, signal })).account_commitment,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * `GET /api/presale/presales/{id}/proof?wallet=`: one wallet's allowlist leaf,
 * shared by the upcoming sale's Blast box and the commit flow. A leaf holds for
 * the session (a sale's root never changes once bound); "not on the list"
 * (`not_eligible`, which a lagging node also answers for a just-published sale)
 * for a minute; any other answer is asked again by the next reader.
 */
export function allowlistLeafQuery(getAccessToken: Token, presaleId: string, wallet: string) {
  return queryOptions({
    queryKey: queryKeys.me.allowlistLeaf(presaleId, wallet),
    queryFn: ({ signal }) => fetchAllowlistLeaf({ getAccessToken, signal }, presaleId, wallet),
    staleTime: (query) => (query.state.data?.status === "ok" ? Infinity : query.state.data?.status === "refused" && query.state.data.code === "not_eligible" ? 60_000 : 0),
    retry: false,
  });
}

/** `GET /api/social/me/wallet`: the Blast wallet's balances. */
export function walletQuery(getAccessToken: Token, listing?: Parameters<typeof fetchWallet>[1]) {
  const params = listing ? {
    page: listing.page, q: listing.q ?? "", hide_small: listing.hide_small ?? false,
    mode: listing.mode === "withdraw" ? "withdraw" : "all",
    key: listing.key ?? "", keys: listing.keys ?? "[]",
    ...(listing.mode === "swap" && { hide_test_markets: true }),
  } : undefined;
  return queryOptions({
    queryKey: params ? queryKeys.me.walletListing(params) : queryKeys.me.wallet(),
    // An invalidated entry (own trade, wallet hint) asks for balances as they are now.
    queryFn: async ({ signal, client, queryKey }) => unwrapApiResult(await fetchWallet({ getAccessToken, signal }, params, client.getQueryState(queryKey)?.isInvalidated === true)),
    staleTime: VIEWER_STALE_MS,
  });
}

/** The current signer, independently of balances and coin metadata. */
export function walletIdentityScope(viewer: Readonly<{ sessionIdentity?: string; callsign: string | null }>) {
  return JSON.stringify([viewer.sessionIdentity, viewer.callsign]);
}

export function walletIdentityQuery(viewer: string, getAccessToken: Token) {
  return queryOptions({
    queryKey: queryKeys.me.walletIdentity(viewer),
    queryFn: async ({ signal }) => unwrapApiResult(await fetchWalletIdentity({ getAccessToken, signal })),
    staleTime: 5_000,
    retry: false,
  });
}

/** `GET /api/social/me/portfolio`: the Portfolio page, the gold card, the rail's Portfolio figures and Blast mode's bar. Wallet holdings come from the indexer; transaction completion invalidates the shared read. */
export const PORTFOLIO_STALE_MS = 60_000;
export function portfolioQuery(getAccessToken: Token, workspaceScope?: string, summary = true) {
  return queryOptions({
    queryKey: queryKeys.me.portfolioRead(workspaceScope, summary),
    queryFn: async ({ signal }) => {
      const result = await fetchPortfolio({ getAccessToken, signal, summary });
      return unwrapApiResult(result.status === "ready" ? { status: "ok", body: result.portfolio } : result.status === "refused" ? { ...result, retryAfterSeconds: result.retryAfterSeconds ?? null } : result);
    },
    staleTime: PORTFOLIO_STALE_MS,
  });
}

/** `GET /api/social/me/presales`: the viewer's positions, holdings and vesting. */
export function mePresalesQuery(getAccessToken: Token, positionsOnly = false) {
  return mePresalesOptions(getAccessToken, positionsOnly, queryKeys.me.presales(positionsOnly));
}

/** Keep workspace identity isolation separate from the legacy key's typed callers. */
export function workspaceMePresalesQuery(getAccessToken: Token, positionsOnly: boolean, workspaceScope: string) {
  return mePresalesOptions(getAccessToken, positionsOnly, [...queryKeys.me.presales(positionsOnly), "workspace", workspaceScope] as const);
}

function mePresalesOptions<Key extends readonly unknown[]>(getAccessToken: Token, positionsOnly: boolean, queryKey: Key) {
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }) => unwrapApiResult(await fetchMePresales({ getAccessToken, signal }, positionsOnly)),
    staleTime: VIEWER_STALE_MS,
    refetchInterval: (query) => {
      const now = Date.now();
      const active = query.state.data?.vestings.filter((vesting) => vesting.end_ms > now || (Number(vesting.claimable) === 0 && Number(vesting.claimed) < Number(vesting.total))) ?? [];
      if (active.length === 0) return false;
      const nextCliff = Math.min(...active.filter((vesting) => vesting.cliff_end_ms > now).map((vesting) => vesting.cliff_end_ms - now));
      return Math.max(1_000, Math.min(pollInterval(30_000, query), nextCliff));
    },
  });
}

/**
 * `GET /api/social/me/rewards?limit=5` (OA-45): what each coin paid and owes,
 * and the five newest payouts — the Portfolio tab, its side card and the
 * Rewards page share it. Fresh a minute, as the portfolio. Keyed by account,
 * so a switch never toasts one account's payouts as another's.
 */
export function rewardsSummaryQuery(getAccessToken: Token, callsign: string) {
  return queryOptions({
    queryKey: queryKeys.me.rewards.summary(callsign),
    queryFn: async () => unwrapApiResult(await fetchRewardsPage({ getAccessToken }, socialRewardsPath({ limit: 5 }))),
    staleTime: PORTFOLIO_STALE_MS,
  });
}

/** One coin's payouts on the Rewards page: five, then ten more a page (the gate's "Show 10 more"). */
export function rewardsCoinQuery(getAccessToken: Token, presaleId: string, vaultId?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.me.rewards.coin(presaleId),
    queryFn: async ({ pageParam }) =>
      unwrapApiResult(await fetchRewardsPage({ getAccessToken }, socialRewardsPath({ ...(vaultId ? { vault: vaultId } : { presale: presaleId }), limit: pageParam === null ? 5 : 10, cursor: pageParam }))),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: PORTFOLIO_STALE_MS,
  });
}

/** `GET /api/social/me/watchlist/keys`: every star on the page, sales and curve coins. */
export function watchlistKeysQuery(getAccessToken: Token) {
  return queryOptions({
    queryKey: queryKeys.me.watchlist.keys(),
    queryFn: async () => unwrapApiResult(await fetchWatchlistKeys({ getAccessToken })),
    staleTime: VIEWER_STALE_MS,
  });
}

/** The right column's watchlist card: the first `limit` rows, stars then follows. */
export function watchlistCardQuery(getAccessToken: Token, limit: number) {
  return queryOptions({
    queryKey: queryKeys.me.watchlist.page(`card:${limit}`),
    queryFn: async () => unwrapApiResult(await fetchWatchlistPage({ getAccessToken }, limit, null, true)),
    staleTime: VIEWER_STALE_MS,
  });
}

/** `GET /api/social/me/notifications/unread`. A focused tab reads it again once it is older than this. */
export const UNREAD_FRESH_MS = 15_000;
export function unreadQuery(getAccessToken: Token) {
  return queryOptions({
    queryKey: queryKeys.me.notifications.unread(),
    queryFn: async () => unwrapApiResult(await fetchUnreadCount({ getAccessToken })),
    staleTime: UNREAD_FRESH_MS,
  });
}

/** `GET /api/social/me/settings`. */
export function settingsQuery(getAccessToken: Token, accountId?: string, principal?: string) {
  return queryOptions({
    queryKey: queryKeys.me.settings(accountId, principal),
    queryFn: async ({ signal }) => unwrapApiResult(await fetchSettings({ getAccessToken, signal })),
    staleTime: VIEWER_STALE_MS,
  });
}

/** `GET /api/social/me/profile`: the profile editor's read. */
export function profileEditQuery(getAccessToken: Token) {
  return queryOptions({
    queryKey: queryKeys.me.profileEdit(),
    queryFn: async () => unwrapApiResult(await fetchProfileEdit({ getAccessToken })),
    staleTime: VIEWER_STALE_MS,
  });
}

/** `GET /api/social/profiles/{callsign}/mutuals` (signed in). */
export function mutualsQuery(getAccessToken: Token, callsign: string) {
  return queryOptions({
    queryKey: queryKeys.me.mutuals(callsign),
    queryFn: async () => unwrapApiResult(await fetchMutuals({ getAccessToken }, callsign)),
    staleTime: VIEWER_STALE_MS,
  });
}

/**
 * `POST /api/social/presales/viewer` `{ presale_ids }`: the viewer's own view
 * of these sales (followed backers, own commitment). The ids are sorted into
 * the key, so any order shares one read; at most 50 (the route's bound).
 */
export function presaleViewerQuery(getAccessToken: Token, presaleIds: readonly string[]) {
  return presaleViewerRequestQuery(getAccessToken, { presale_ids: presaleIds });
}

/** The same read for any of its requests: by ids, by list status (the "Following" sort), or the viewer's own (`mine`). */
export function presaleViewerRequestQuery(getAccessToken: Token, request: SocialPresaleViewerRequest) {
  const body: SocialPresaleViewerRequest = "presale_ids" in request ? { presale_ids: sortedIds(request.presale_ids).slice(0, 50) } : request;
  const queryKey =
    "presale_ids" in body
      ? queryKeys.me.presaleViewer(body.presale_ids)
      : ([...queryKeys.me.presaleViewerAll, "mine" in body ? "mine" : `status:${body.status}`] as const);
  return queryOptions({
    queryKey,
    queryFn: async () => unwrapApiResult(await callSocialApi({ getAccessToken }, SOCIAL_PRESALE_VIEWER_PATH, {
      method: "POST",
      body,
      ...("presale_ids" in body ? { headers: { [PRESALE_COMMIT_FIELDS_HEADER]: "1" } } : {}),
    }, socialPresaleViewerResponseSchema)),
    staleTime: VIEWER_STALE_MS,
  });
}

/** Pages live below the portfolio prefix so completed trades invalidate them too. */
export function portfolioCoinsQuery(getAccessToken: Token, page: number, search: string, hideSmall = false, workspaceScope?: string) {
  return queryOptions({
    queryKey: workspaceScope ? [...queryKeys.me.portfolioCoins(page, search, hideSmall), "workspace", workspaceScope] as const : queryKeys.me.portfolioCoins(page, search, hideSmall),
    queryFn: async ({ signal }) => unwrapApiResult(await fetchPortfolioCoins({ getAccessToken, page, search, hideSmall, signal })),
    staleTime: PORTFOLIO_STALE_MS,
  });
}
