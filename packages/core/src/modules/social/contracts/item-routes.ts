import { z } from "zod";
import { socialAsOfSchema, socialFeedItemSchema, type FeedReadonly } from "./items.ts";

/**
 * One public item and the rocket reaction on it.
 *
 * `GET /api/social/items/{entry_id}`: the item behind a post permalink
 * (`/p/<post id>`, FEATURE-MAP §3.7 "Copy link to post"). No
 * authentication, read on the replica, bucket `social_read`, publicly cached
 * like the feed. An entry that is not visible (unnamed and not a presale post,
 * or a kind the feed hides) or does not exist is `404 not_found`. JSON Schema:
 * `schemas/item-response.schema.json`.
 *
 * `PUT /api/social/items/{entry_id}/reactions/{reaction}` adds the caller's
 * reaction and `DELETE` removes it; both answer `204` and are idempotent
 * (T-010). Account required, bucket `social_reaction` (240 per minute per
 * account), written on the primary. A key not in `social_config.reactions`
 * (OA-5: `["rocket"]`) is `422 invalid_reaction`; an entry that is not
 * visible is `404 not_found`; a malformed id or key is `400
 * invalid_parameter` naming `entry_id` or `reaction`.
 *
 * `entry_id` is path-encoded (`encodeURIComponent`: `a%3A12%3A0%3A0%3A0`).
 */
export const SOCIAL_ITEM_ROUTE = "GET /api/social/items/{entry_id}";
export const SOCIAL_REACTION_ROUTE = "/api/social/items/{entry_id}/reactions/{reaction}";
export const SOCIAL_ITEMS_PREFIX = "/api/social/items/";

export type SocialItemResponse = FeedReadonly<z.infer<typeof socialItemResponseSchema>>;

/** The item route of `entryId`. */
export function socialItemPath(entryId: string): string {
  return `${SOCIAL_ITEMS_PREFIX}${encodeURIComponent(entryId)}`;
}

/** The reaction route of `reaction` on `entryId`. */
export function socialReactionPath(entryId: string, reaction: string): string {
  return `${socialItemPath(entryId)}/reactions/${encodeURIComponent(reaction)}`;
}

/**
 * A post's permalink id (`/p/<post id>`): the entry id with `:` written as
 * `-`. Entry ids never hold `-` (decimal numbers, `0x` hex ids, lowercase
 * kinds and states), so the mapping is reversible and stable: the same chain
 * fact always has the same link.
 */
export function postIdOf(entryId: string): string {
  return entryId.replaceAll(":", "-");
}

/** The entry id of a post id, or null when it is not one `postIdOf` makes. */
export function entryIdOfPost(postId: string): string | null {
  if (
    !z
      .string()
      .min(1)
      .max(260)
      .refine((value) => !value.includes(":"))
      .safeParse(postId).success
  )
    return null;
  const entryId = postId.replaceAll("-", ":");
  return z
    .string()
    .regex(/^[alm]:[!-~]{1,250}$/)
    .safeParse(entryId).success
    ? entryId
    : null;
}

/** A post's page path. */
export function postPath(entryId: string): string {
  return `/p/${postIdOf(entryId)}`;
}

export const socialItemResponseSchema = z
  .strictObject({
    item: socialFeedItemSchema,
    as_of: socialAsOfSchema,
  })
  .meta({
    title: "Social public item",
    description:
      "GET /api/social/items/{entry_id} 200: one visible item (a post permalink), the same for every caller.",
  });
