import { z } from "zod";

import { socialAsOfSchema } from "./items.ts";
import {
  type PresaleReadonly,
  socialPresaleSummarySchema,
  presaleIntegerSchema,
} from "./presale-schemas.ts";

import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The watchlist (owner decision OA-11; canonical UI §5.5, §10.2): presales and
 * bonding-curve coins an account starred, a saved list separate from following a presale (the bell
 * stays the follow). Personal: account required (`401 unauthorized`, `409
 * account_required`), read and written on the primary, `Cache-Control:
 * private, no-store`.
 *
 * - `PUT /api/social/me/watchlist/{presale_id}`: `204`, idempotent (a star
 *   already there keeps its time). The key is a presale id, or a
 *   bonding-curve coin's type (`0x…::module::Name`, URL-encoded). A presale id
 *   not in `chain_read_v1.presales`, or a coin type with no launch vault, is
 *   `404 not_found`; a new star past
 *   `SOCIAL_WATCHLIST_LIMIT` is `422 watchlist_limit`. Bucket
 *   `social_watchlist`.
 * - `DELETE` on the same path: `204` whether or not it was starred (any
 *   well-formed id, so a star can always be removed). Bucket
 *   `social_watchlist`.
 * - `GET /api/social/me/watchlist?cursor=&limit=&include=`: one keyset page,
 *   newest star first (`limit` 1 to `WATCHLIST_PAGE_MAX`, default
 *   `WATCHLIST_PAGE_DEFAULT`; `cursor` the previous page's `next_cursor`),
 *   with each presale's list summary and the total. Saved curve coins are
 *   not on the page (it lists sales) and not in its total. A star whose presale
 *   blast-infra no longer lists is left out. Bucket `social_read`. Schema
 *   `watchlist-page`. `include=follows` (OA-17, the right column's Watchlist
 *   card) adds the presales the account follows: every star first (newest
 *   first), then each followed presale not starred (newest follow first); the
 *   total counts that union. Without it the page is the stars only (the
 *   presale list's Watchlist filter). A cursor belongs to its own kind of
 *   read.
 * - `GET /api/social/me/watchlist/ids`: every starred presale id, newest
 *   first (at most `SOCIAL_WATCHLIST_LIMIT`), for the stars on a page. Saved
 *   curve coins are not in it. Bucket `social_read`. Schema
 *   `watchlist-ids-response`.
 * - `GET /api/social/me/watchlist/keys`: every saved key, presale ids and
 *   curve coin types in one list, newest first (at most
 *   `SOCIAL_WATCHLIST_LIMIT`), for Home's Save buttons and Watchlist tab.
 *   Bucket `social_read`. Schema `watchlist-keys-response`.
 *
 * A malformed id, cursor or limit is `400 invalid_parameter` (`parameter`
 * names it).
 */
export const SOCIAL_WATCHLIST_PATH = "/api/social/me/watchlist";
export const SOCIAL_WATCHLIST_IDS_PATH = "/api/social/me/watchlist/ids";
export const SOCIAL_WATCHLIST_KEYS_PATH = "/api/social/me/watchlist/keys";
export const SOCIAL_WATCHLIST_ITEM_PREFIX = "/api/social/me/watchlist/";
export const SOCIAL_WATCHLIST_ROUTE = "GET /api/social/me/watchlist";
export const SOCIAL_WATCHLIST_IDS_ROUTE = "GET /api/social/me/watchlist/ids";
export const SOCIAL_WATCHLIST_KEYS_ROUTE = "GET /api/social/me/watchlist/keys";
export const SOCIAL_WATCHLIST_ITEM_ROUTE =
  "/api/social/me/watchlist/{presale_id}";

/** The most presales and curve coins one account can star, together. */
export const SOCIAL_WATCHLIST_LIMIT = 500;
export const WATCHLIST_PAGE_DEFAULT = 20;
export const WATCHLIST_PAGE_MAX = 50;
/** `include=` value that adds followed presales to a watchlist page (OA-17). */
export const WATCHLIST_INCLUDE_FOLLOWS = "follows";

export const socialWatchlistItemSchema = z.strictObject({
  presale: socialPresaleSummarySchema,
  added_ms: presaleIntegerSchema,
  starred: z.boolean(),
  followed: z.boolean(),
});

export type SocialWatchlistItem = PresaleReadonly<
  z.infer<typeof socialWatchlistItemSchema>
>;

export const socialWatchlistPageSchema = z
  .strictObject({
    items: z.array(socialWatchlistItemSchema).max(50),
    total: presaleIntegerSchema,
    next_cursor: z.union([z.null(), z.string().min(1).max(512)]),
    as_of: socialAsOfSchema,
  })
  .meta({
    title: "Watchlist page",
    description:
      "GET /api/social/me/watchlist 200: one keyset page of the caller's starred presales, newest first; with include=follows, then the followed presales not starred, newest follow first (private, never cached).",
  });

export type SocialWatchlistPage = PresaleReadonly<
  z.infer<typeof socialWatchlistPageSchema>
>;

export const socialWatchlistIdsSchema = z
  .strictObject({
    presale_ids: z
      .array(z.string().regex(SUI_OBJECT_ID_PATTERN))
      .max(SOCIAL_WATCHLIST_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length)
      .meta({ uniqueItems: true }),
  })
  .meta({
    title: "Watchlist ids",
    description:
      "GET /api/social/me/watchlist/ids 200: every presale id the caller starred, newest first (private, never cached).",
  });

export type SocialWatchlistIds = Readonly<{
  presale_ids: PresaleReadonly<
    z.infer<typeof socialWatchlistIdsSchema>["presale_ids"]
  >;
}>;

/** A saved key: a presale id, or a bonding-curve coin's type. */
export const socialWatchlistKeySchema = z.union([
  z.string().regex(SUI_OBJECT_ID_PATTERN),
  z.string().regex(COIN_TYPE),
]);

export const socialWatchlistKeysSchema = z
  .strictObject({
    keys: z
      .array(socialWatchlistKeySchema)
      .max(SOCIAL_WATCHLIST_LIMIT)
      .refine((keys) => new Set(keys).size === keys.length)
      .meta({ uniqueItems: true }),
  })
  .meta({
    title: "Watchlist keys",
    description:
      "GET /api/social/me/watchlist/keys 200: every key the caller saved, presale ids and curve coin types together, newest first (private, never cached).",
  });

export type SocialWatchlistKeys = Readonly<{
  keys: readonly string[];
}>;

/** The star's path for one presale, or one curve coin by its coin type. */
export function socialWatchlistItemPath(key: string): string {
  return `${SOCIAL_WATCHLIST_ITEM_PREFIX}${encodeURIComponent(key)}`;
}
