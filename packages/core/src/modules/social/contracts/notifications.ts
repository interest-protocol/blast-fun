import type { FeedReadonly } from "./items.ts";
import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The notifications contract (canonical UI §13, owner decision OA-11). Every
 * route is the signed-in account's own data: `auth: "account"`, an account
 * required, `Cache-Control: private, no-store`.
 *
 * - `GET /api/social/me/notifications?cursor=&limit=`: a page, newest event
 *   first (`notification-page`), with the unread count.
 * - `GET /api/social/me/notifications/unread`: the unread count only
 *   (`notification-unread-response`), for the shell's badge.
 * - `POST /api/social/me/notifications/{id}/read`: marks one read.
 * - `POST /api/social/me/notifications/read`: marks notifications through the
 *   fetched ID in `{ through }`. Older clients with an empty body mark all read.
 *   Both answer `notification-unread-response`; repeating either is harmless.
 *
 * Kinds and the switch (`social_notification_preferences`, 0059) that turns
 * each source off:
 *
 * | kind | source | switch |
 * | --- | --- | --- |
 * | `fill` | a followed or backed sale passes a backer milestone (`participant_milestones`) or 80% of its target | `almost_full` |
 * | `follow` | an account the recipient follows commits, named by the naming rule | `people_you_follow` |
 * | `claim` | a backed sale migrates (tokens) or is cancelled (refunds), not yet claimed | `claims_open` |
 * | `funded` | a backed sale is funded | `funded` |
 * | `soon` | a followed sale opens within the hour (`opens_soon`); a backed open sale closes within the hour (`last_hour`) | `opens_soon`, `last_hour` |
 * | `unlock` | a backed sale's team vesting starts within the lead time | `unlocks` |
 * | `call_up` | a sale the recipient called (a named commit, OA-9) trades past +50%, +100%, +200%, +500% or +1,000% over its entry price, the highest threshold crossed and only once each | `call_moves` |
 */

export const NOTIFICATION_KINDS = [
  "fill",
  "follow",
  "claim",
  "funded",
  "soon",
  "unlock",
  "call_up",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const SOCIAL_NOTIFICATIONS_ROUTE = "GET /api/social/me/notifications";
export const SOCIAL_NOTIFICATIONS_PATH = "/api/social/me/notifications";
export const SOCIAL_NOTIFICATIONS_UNREAD_ROUTE = "GET /api/social/me/notifications/unread";
export const SOCIAL_NOTIFICATIONS_UNREAD_PATH = "/api/social/me/notifications/unread";
export const SOCIAL_NOTIFICATION_READ_ROUTE = "POST /api/social/me/notifications/{id}/read";
export const SOCIAL_NOTIFICATIONS_READ_ALL_ROUTE = "POST /api/social/me/notifications/read";
export const SOCIAL_NOTIFICATIONS_READ_ALL_PATH = "/api/social/me/notifications/read";

export const NOTIFICATION_PAGE_DEFAULT_LIMIT = 30;
export const NOTIFICATION_PAGE_MAX_LIMIT = 50;
/** The unread count stops at this; the badge shows `99+` above 99. */
export const NOTIFICATION_UNREAD_CAP = 100;

/** A notification id: the row's positive integer id, as decimal text. */
export const NOTIFICATION_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const MAX_NOTIFICATION_ID = 9_223_372_036_854_775_807n;

/** A positive ID that fits the notification table's signed BIGINT column. */
export const notificationIdSchema = z
  .string()
  .regex(NOTIFICATION_ID_PATTERN)
  .pipe(z.string().refine((value) => BigInt(value) <= MAX_NOTIFICATION_ID));

export function isNotificationId(value: unknown): value is string {
  return notificationIdSchema.safeParse(value).success;
}

export type NotificationPresale = FeedReadonly<
  z.infer<(typeof socialNotificationSchema.shape.presale.options)[1]>
>;

/** The account a `follow` notification is about (its public identity). */
export type NotificationActor = FeedReadonly<
  z.infer<(typeof socialNotificationSchema.shape.actor.options)[1]>
>;

export type SocialNotification = FeedReadonly<z.infer<typeof socialNotificationSchema>>;

export type SocialNotificationPage = FeedReadonly<z.infer<typeof socialNotificationWirePageSchema>>;

export const socialNotificationUnreadSchema = z
  .strictObject({
    unread_count: z.number().int().nonnegative().max(NOTIFICATION_UNREAD_CAP),
  })
  .meta({
    title: "The caller's unread notification count",
    description: `GET /api/social/me/notifications/unread, POST /api/social/me/notifications/{id}/read and POST /api/social/me/notifications/read 200: unread notifications, capped at ${NOTIFICATION_UNREAD_CAP}.`,
  });

export type SocialNotificationUnread = Readonly<z.infer<typeof socialNotificationUnreadSchema>>;

export const socialNotificationPageSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[1-9][0-9]{0,18}$/),
          kind: z.enum(["fill", "follow", "claim", "funded", "soon", "unlock", "call_up"]),
          title: z
            .string()
            .min(1)
            .refine((value) => Array.from(value).length <= 300)
            .meta({ maxLength: 300 }),
          sub: z
            .string()
            .refine((value) => Array.from(value).length <= 600)
            .meta({ maxLength: 600 }),
          occurred_at_ms: z.number().min(0).refine(Number.isInteger).meta({ type: "integer" }),
          read: z.boolean(),
          href: z.string().regex(/^\//),
          presale: z.xor([
            z.null(),
            z.strictObject({
              presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
              name: z.string(),
              symbol: z.string(),
              icon_url: z.string(),
              coin_type: z
                .string()
                .min(1)
                .meta({
                  description: "Canonical sale coin type; optional for older cached responses.",
                })
                .optional(),
            }),
          ]),
          actor: z.xor([
            z.null(),
            z.strictObject({
              callsign: z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
              display_name: z.xor([z.null(), z.string()]),
              avatar_url: z.xor([z.null(), z.string()]),
              verified: z.boolean(),
            }),
          ]),
        }),
      )
      .max(50),
    next_cursor: z.xor([
      z.null(),
      z
        .string()
        .min(1)
        .refine((value) => Array.from(value).length <= 256)
        .meta({ maxLength: 256 }),
    ]),
    unread_count: z.number().min(0).max(100).refine(Number.isInteger).meta({ type: "integer" }),
  })
  .meta({
    title: "A page of the caller's notifications",
    description:
      "GET /api/social/me/notifications 200: newest event first (keyset), the next page's cursor and the unread count (capped at 100).",
  });

// Read-time copy includes the complete quoted why and chain-provided sale name.
// The published 300/600 bounds predate that producer and do not constrain its output.
export const socialNotificationSchema = socialNotificationPageSchema.shape.items.element.extend({
  title: z.string(),
  sub: z.string(),
});

export const socialNotificationWirePageSchema = socialNotificationPageSchema.extend({
  items: z.array(socialNotificationSchema).max(NOTIFICATION_PAGE_MAX_LIMIT),
});
