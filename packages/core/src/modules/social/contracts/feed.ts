import { z } from "zod";
import { socialAsOfSchema, socialFeedItemSchema, type FeedReadonly } from "./items.ts";

/**
 * `GET /api/social/feed?tab=for_you&cursor=&limit=`: the public home feed.
 * JSON Schema: `schemas/feed-page.schema.json`.
 *
 * No authentication; a token changes nothing. Every answer is the same for
 * every caller and carries no viewer-specific field. Public responses allow
 * up to 10 s of shared freshness and 20 s of stale revalidation. The default
 * first page uses the same 10 s budget at the origin and the CDN.
 */
export const SOCIAL_FEED_ROUTE = "GET /api/social/feed";
export const SOCIAL_FEED_PATH = "/api/social/feed";

/**
 * Accepted `tab` values; an absent `tab` is `for_you`. `following` (a later
 * ticket) and anything else is `400 invalid_parameter` (parameter `tab`).
 */
export const SOCIAL_FEED_TABS = ["for_you"] as const;
export type SocialFeedTab = (typeof SOCIAL_FEED_TABS)[number];
export const SOCIAL_FEED_DEFAULT_TAB: SocialFeedTab = "for_you";

/** A page of the feed. */
export type SocialFeedPage = FeedReadonly<z.infer<typeof socialFeedPageSchema>>;

/** Above this `as_of.lag_ms` a client shows "Activity is delayed" over the data it has. */
export const SOCIAL_FEED_DELAYED_LAG_MS = 60_000;

/**
 * The item kinds the home feed leaves out while trading surfaces are hidden
 * (OA-7: hidden until R1, as the canonical UI's `FLAGS.trading = false`).
 * The server shows them only when `BLAST_TRADING_ENABLED` is exactly "true".
 */
export const SOCIAL_FEED_TRADE_KINDS = ["trade_buy", "trade_sell"] as const;

/**
 * `GET /api/social/feed/new?since=<ms>`: how many For You items are newer than
 * `since` (the newest `occurred_at_ms` the reader has), for the "N new posts"
 * pill (FEATURE-MAP §2.3, T-012). JSON Schema: `schemas/feed-new-response.schema.json`.
 *
 * - No authentication; the answer depends only on `since`, so a 200 is
 *   publicly cached like the feed (`public, s-maxage=10,
 *   stale-while-revalidate=20`); readers of the same first page share it.
 * - `since` is required, once, a non-negative integer of milliseconds;
 *   anything else is `400 invalid_parameter` (parameter `since`).
 * - Read on the replica; bucket `social_read` (IP).
 * - The count stops at `SOCIAL_FEED_NEW_MAX`: `more` says there are more.
 *
 * The client asks on its own schedule (a 30 s poll while the tab is visible
 * today; later a blast-infra activity hint, T-035). It never renders from the
 * count: tapping the pill refetches the first page.
 */
export const SOCIAL_FEED_NEW_ROUTE = "GET /api/social/feed/new";
export const SOCIAL_FEED_NEW_PATH = "/api/social/feed/new";
export const SOCIAL_FEED_NEW_MAX = 50;
/** The pill shows up to three faces: the newest named actors. */
export const SOCIAL_FEED_NEW_ACTORS = 3;

/** A face on the "N new posts" pill: a named actor of one of the new items. */
export type SocialFeedNewActor = FeedReadonly<
  z.infer<typeof socialFeedNewResponseSchema.shape.actors.element>
>;

export type SocialFeedNewResponse = FeedReadonly<z.infer<typeof socialFeedNewResponseSchema>>;

export const socialFeedPageSchema = z
  .strictObject({
    items: z.array(socialFeedItemSchema).max(50),
    next_cursor: z.xor([
      z.null(),
      z
        .string()
        .min(1)
        .refine((value) => Array.from(value).length <= 1024)
        .meta({ maxLength: 1024 })
        .meta({
          description: "Opaque. Pass back unchanged as cursor for the next page.",
        }),
    ]),
    as_of: socialAsOfSchema,
  })
  .meta({
    title: "Social feed page",
    description:
      "GET /api/social/feed 200: one page of the public home feed, the same for every caller. Pinned presales come first (latest pin first, one latest public post per sale); remaining items rank by occurred_at_ms plus the active-why and big boosts, descending, then entry_id descending. No viewer-specific field.",
  });

export const socialFeedNewResponseSchema = z
  .strictObject({
    count: z.number().min(0).max(50).refine(Number.isInteger).meta({ type: "integer" }),
    more: z.boolean().meta({ description: "True when more than count items are newer." }),
    actors: z
      .array(
        z.strictObject({
          callsign: z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
          display_name: z.xor([z.null(), z.string().min(1)]),
          avatar_url: z.xor([z.null(), z.string().min(1)]),
        }),
      )
      .max(3),
    as_of: socialAsOfSchema,
  })
  .meta({
    title: "Social feed new-items count",
    description:
      "GET /api/social/feed/new?since=<ms> 200: how many For You items are newer than since, capped, with the newest named actors' faces. The same for every caller.",
  });
