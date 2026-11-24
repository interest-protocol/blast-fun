import { z } from "zod";
import {
  SOCIAL_WATCHLIST_KEYS_PATH,
  SOCIAL_WATCHLIST_PATH,
  WATCHLIST_INCLUDE_FOLLOWS,
  socialWatchlistKeysSchema,
  socialWatchlistPageSchema,
  socialWatchlistItemPath,
  type SocialWatchlistKeys,
  type SocialWatchlistPage,
} from "@blast/core/web/contracts/watchlist.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * The watchlist's calls (UI-12, OA-11), each through the shared signed-in
 * call (`callSocialApi`: a Privy token or the wallet session, OA-16), never
 * cached.
 */
export function isWatchlistPage(value: unknown): value is SocialWatchlistPage {
  return socialWatchlistPageSchema.safeParse(value).success;
}

/** A `204` has no body. */
const noBodySchema = z.null();

/** Every saved key, sales and curve coins, newest first. */
export function fetchWatchlistKeys(options: SocialApiOptions): Promise<ApiResult<SocialWatchlistKeys>> {
  return callSocialApi(options, SOCIAL_WATCHLIST_KEYS_PATH, { method: "GET" }, socialWatchlistKeysSchema);
}

/**
 * One page of stars (the presale list's Watchlist filter), or with
 * `includeFollows` the right column's card: the stars, then the followed
 * presales not starred (OA-17).
 */
export function fetchWatchlistPage(
  options: SocialApiOptions,
  limit: number,
  cursor: string | null = null,
  includeFollows = false,
): Promise<ApiResult<SocialWatchlistPage>> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (includeFollows) query.set("include", WATCHLIST_INCLUDE_FOLLOWS);
  if (cursor) query.set("cursor", cursor);
  return callSocialApi(options, `${SOCIAL_WATCHLIST_PATH}?${query}`, { method: "GET" }, socialWatchlistPageSchema);
}

/** Stars (`on`) or unstars a presale or curve coin; both are idempotent. */
export function setWatched(options: SocialApiOptions, presaleId: string, on: boolean): Promise<ApiResult<null>> {
  return callSocialApi(options, socialWatchlistItemPath(presaleId), { method: on ? "PUT" : "DELETE" }, noBodySchema);
}
