import { z } from "zod";

import { socialCallsignSchema } from "@blast/core/modules/social/contracts/primitives.ts";
import { socialAsOfSchema, socialFeedItemSchema, type FeedItem } from "@blast/core/modules/social/contracts/items.ts";

/**
 * Public profiles: `/crew/<callsign>` and its two routes. No authentication
 * (the Authorization header is never read), bucket `social_read` (IP), read
 * on the replica. A 200 is publicly cached
 * (`public, s-maxage=10, stale-while-revalidate=20`); errors are `no-store`.
 * Neither answer carries a viewer-specific field or any portfolio field
 * (balances, positions, coins, vesting, attribution totals).
 *
 * - `GET /api/social/profiles/{callsign}`: the account's public identity,
 *   whether it is verified (X linked), private, and whether its portfolio is
 *   public (`SocialProfile`; schema `schemas/profile-response.schema.json`).
 *   A Mission Control member who never opened Blast gets its account row on
 *   this first read (on the primary), as `GET /me` would create it.
 * - `GET /api/social/profiles/{callsign}/items?cursor=&limit=`: the account's
 *   named items only, newest first (`occurred_at_ms`, then `entry_id`,
 *   descending), paged like the feed (`limit` 1 to 50, default 20; opaque
 *   `cursor`). A private account, or one not sharing yet, has none. Schema
 *   `schemas/profile-items-page.schema.json`.
 *
 * Refusals: a malformed callsign, `limit` or `cursor` is `400
 * invalid_parameter` (`parameter` names it); a callsign no Blast Account
 * holds is `404 not_found`; no readable watermark is `503
 * service_unavailable`.
 */
export const SOCIAL_PROFILE_ROUTE = "GET /api/social/profiles/{callsign}";
export const SOCIAL_PROFILE_ITEMS_ROUTE = "GET /api/social/profiles/{callsign}/items";
const SOCIAL_PROFILES_PREFIX = "/api/social/profiles/";
const PROFILE_BIO_QUERY = "include_bio";

const nullableProfileText = z.xor([z.null(), z.string().min(1)]);

export const PROFILE_BIO_MAX = 160;

// Older clients reject unknown fields in the profile response.
export function withProfileBio(path: string): string {
  return path + `?${PROFILE_BIO_QUERY}=1`;
}

export function profileBioRequested(request: Request): boolean {
  return new URL(request.url).searchParams.get(PROFILE_BIO_QUERY) === "1";
}

export const profileBioSchema = z.string().min(1)
  .refine((value) => [...value].length <= PROFILE_BIO_MAX)
  .meta({ maxLength: PROFILE_BIO_MAX });

export function normalizeProfileBio(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export const socialProfileSchema = z.strictObject({
  callsign: socialCallsignSchema,
  display_name: nullableProfileText,
  bio: profileBioSchema.optional().meta({ description: "Present when set and requested with ?include_bio=1." }),
  avatar_url: nullableProfileText,
  x_handle: nullableProfileText,
  verified: z.boolean().meta({ description: "OA-8: the account has a linked X account (a Mission Control member always has)." }),
  private: z.boolean(),
  portfolio_public: z.boolean().meta({ description: "OA-10: the owner turned on Public portfolio and the account is public, so GET …/portfolio answers." }),
  as_of: socialAsOfSchema,
}).meta({
  title: "Social public profile",
  description: "GET /api/social/profiles/{callsign} 200: a Blast Account's public identity, whether it is verified (X linked), private, and whether its portfolio is public. The same for every caller; no viewer-specific field and no portfolio field.",
});

export type SocialProfile = Readonly<z.infer<typeof socialProfileSchema>>;

export const socialProfileItemsPageSchema = z.strictObject({
  items: z.array(socialFeedItemSchema).max(50),
  next_cursor: z.xor([
    z.null(),
    z.string().min(1).refine((text) => [...text].length <= 1_024).meta({
      maxLength: 1_024,
      description: "Opaque. Pass back unchanged as cursor for the next page.",
    }),
  ]),
  as_of: socialAsOfSchema,
}).meta({
  title: "Social profile items page",
  description: "GET /api/social/profiles/{callsign}/items 200: one page of the account's named items, newest first (occurred_at_ms, then entry_id, descending). Empty for a private account or one not sharing. The same for every caller; no viewer-specific field.",
});

export type SocialProfileItemsPage = Readonly<Omit<z.infer<typeof socialProfileItemsPageSchema>, "items"> & {
  items: readonly FeedItem[];
}>;

/** Whether `value` is a callsign a profile can live at. */
export function isProfileCallsign(value: unknown): value is string {
  return socialCallsignSchema.safeParse(value).success;
}

/** `GET` path of a profile's identity. */
export function socialProfilePath(callsign: string): string {
  return `${SOCIAL_PROFILES_PREFIX}${encodeURIComponent(callsign)}`;
}

/** `GET` path of a profile's items (first page). */
export function socialProfileItemsPath(callsign: string): string {
  return `${socialProfilePath(callsign)}/items`;
}

/**
 * A profile's page path, `/@<callsign>` (OA-4: the canonical profile URL; the
 * proxy rewrites it to the profile page). Item actors and backers carry it.
 */
export function profilePagePath(callsign: string): string {
  return `/@${callsign}`;
}
