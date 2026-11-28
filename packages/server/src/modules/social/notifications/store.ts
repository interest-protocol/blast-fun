import { z } from "zod";
import { socialParameter } from "../route-kit/validation.ts";
import { socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { createHash } from "node:crypto";

import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  notificationIdSchema,
  NOTIFICATION_PAGE_DEFAULT_LIMIT,
  NOTIFICATION_PAGE_MAX_LIMIT,
  NOTIFICATION_UNREAD_CAP,
  type SocialNotificationPage,
  type SocialNotificationUnreadNewest,
} from "@blast/core/modules/social/contracts/notifications.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { renderNotification, type NotificationRow } from "./copy.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { displayPriceOf } from "@blast/core/modules/social/prices/test-sui.ts";

/**
 * The web runtime's side of `social_notifications` (0064): an account's page,
 * its unread count and marking read. Every statement is keyed by the
 * account id the route kit resolved, so a caller only ever reaches its own
 * rows. Reads run on the primary, so a mark-read is read back at once.
 *
 * Read state: a row is read when its `read_at` is set (opened) or its id is
 * at or below the account's "Mark all as read" watermark
 * (`social_notification_reads`).
 *
 * A `follow` notification is shown only while the naming rule still names
 * its actor at the event (the account is public and was sharing then), so an
 * account that goes private disappears from old notifications too; the
 * unread count applies the same filter.
 *
 * Only sales the web shows: a row whose sale `SHOWN_PRESALES` does not hold
 * (T-043's hidden test sales, a sale whose coin metadata has not arrived) is
 * left out of the page and the count, inside the scan before the `LIMIT`, so
 * it never shortens a page. The generator writes none for a hidden sale's
 * commit; this also covers rows written before it stopped, and a sale hidden
 * after its rows were written.
 */

/** A followed actor still named at the event (`n`: the notification, `actor`: its account). */
const STILL_NAMED = `(n.actor_account_id IS NULL OR (
    actor.privacy = 'public' AND actor.sharing_since IS NOT NULL
    AND extract(epoch FROM actor.sharing_since) * 1000 <= n.occurred_at_ms))`;

/** The account's "Mark all as read" watermark (0 before the first). */
const READ_THROUGH = "(SELECT COALESCE(max(r.read_through), 0) AS id FROM social_notification_reads r WHERE r.account_id = $1)";

const PAGE_SQL = `
  SELECT n.notification_id::text AS id, n.kind, n.presale_id, n.occurred_at_ms::text AS occurred_at_ms, n.data,
    (n.read_at IS NOT NULL OR n.notification_id <= through.id) AS read,
    p.sale_name, p.sale_symbol, p.sale_icon_url, p.sale_token, p.quote_decimals::int AS quote_decimals, p.quote_symbol, p.lifecycle,
    p.start_ms::text AS start_ms, p.end_ms::text AS end_ms, p.raise_target::text AS raise_target,
    p.total_commitments::text AS total_commitments, p.venue,
    i.callsign, i.display_name, i.avatar_url, i.x_handle,
    (SELECT w.text FROM social_whys w
     WHERE n.kind = 'follow' AND w.entry_id = n.entry_id AND w.state = 'active' AND w.author_account_id = n.actor_account_id) AS why,
    price.usd_price::text AS price_usd, price.as_of_ms::text AS price_as_of_ms
  FROM social_notifications n
  CROSS JOIN ${READ_THROUGH} AS through
  LEFT JOIN social_accounts actor ON actor.account_id = n.actor_account_id
  LEFT JOIN social_account_identities i ON i.account_id = n.actor_account_id
  JOIN ${SHOWN_PRESALES} p ON p.presale_id = n.presale_id
  LEFT JOIN ${displayPriceOf("p.sale_token", "n.kind = 'call_up'")} price ON TRUE
  WHERE n.account_id = $1
    AND ($2::bigint IS NULL OR (n.occurred_at_ms, n.notification_id) < ($2::bigint, $3::bigint))
    AND ${STILL_NAMED}
  ORDER BY n.occurred_at_ms DESC, n.notification_id DESC
  LIMIT $4`;

/**
 * An account's unread, shown notifications (`n`), shared by the count and the
 * newest ID. The watermark is a scalar subquery, not a join, so it bounds the
 * `social_notifications_unread_idx` scan: with everything read through it, the
 * newest-ID scan stops at once instead of walking every row below it.
 */
const UNREAD_ROWS = `social_notifications n
    LEFT JOIN social_accounts actor ON actor.account_id = n.actor_account_id
    WHERE n.account_id = $1 AND n.read_at IS NULL
      AND n.notification_id > ${READ_THROUGH}
      AND ${STILL_NAMED}
      AND EXISTS (SELECT 1 FROM ${SHOWN_PRESALES} p WHERE p.presale_id = n.presale_id)`;

const UNREAD_SQL = `
  SELECT count(*)::int AS unread FROM (SELECT 1 FROM ${UNREAD_ROWS} LIMIT ${NOTIFICATION_UNREAD_CAP}) AS unread`;

/** The count and the highest unread ID in one statement; the ID reads `social_notifications_unread_idx` from the top, above the watermark. */
const UNREAD_NEWEST_SQL = `
  SELECT (${UNREAD_SQL}) AS unread,
    (SELECT n.notification_id::text FROM ${UNREAD_ROWS} ORDER BY n.notification_id DESC LIMIT 1) AS newest`;

const CURSOR_VERSION = 1;
const CHECK_LENGTH = 8;
const LIMIT = /^[1-9][0-9]{0,2}$/;

function check(body: string): string {
  return createHash("sha256").update(`social-notification-cursor:${body}`).digest("base64url").slice(0, CHECK_LENGTH);
}

export type NotificationCursor = Readonly<{ occurredAtMs: number; id: string }>;

/** The opaque cursor after `position` (a page's last row). */
export function encodeNotificationCursor(position: NotificationCursor): string {
  const body = Buffer.from(JSON.stringify([CURSOR_VERSION, position.occurredAtMs, position.id]), "utf8").toString("base64url");
  return `${body}.${check(body)}`;
}

function invalid(parameter: string): SocialRouteError<"invalid_parameter"> {
  return new SocialRouteError("invalid_parameter", { extra: { parameter } });
}

/** The position a cursor names; anything this codec did not produce is `invalid_parameter` (`cursor`). */
const notificationCursorSchema = z.tuple([z.literal(CURSOR_VERSION), socialCountSchema, notificationIdSchema]);

export function decodeNotificationCursor(cursor: string): NotificationCursor {
  if (cursor.length > 256) throw invalid("cursor");
  const [body, value, ...rest] = cursor.split(".");
  if (rest.length || !body || !value || !/^[A-Za-z0-9_-]+$/.test(body) || value !== check(body)) throw invalid("cursor");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalid("cursor");
  }
  const parsed = notificationCursorSchema.safeParse(decoded);
  if (!parsed.success) throw invalid("cursor");
  const [, occurredAtMs, id] = parsed.data;
  return { occurredAtMs, id };
}

export type NotificationPageRequest = Readonly<{ limit: number; before: NotificationCursor | null }>;

/** `limit` (1 to 50, default 30) and `cursor` from a query string. */
export function parseNotificationPage(searchParams: URLSearchParams): NotificationPageRequest {
  const rawLimit = searchParams.get("limit");
  const limit = socialParameter(z.string().regex(LIMIT).transform(Number).pipe(z.number().min(1).max(NOTIFICATION_PAGE_MAX_LIMIT)).nullable().transform((value) => value ?? NOTIFICATION_PAGE_DEFAULT_LIMIT), rawLimit, "limit");
  const cursor = searchParams.get("cursor");
  return { limit, before: cursor === null ? null : decodeNotificationCursor(cursor) };
}

/** Unread notifications of `accountId`, up to `NOTIFICATION_UNREAD_CAP`. */
export async function readUnreadCount(db: ReadableDatabase, accountId: string): Promise<number> {
  const result = await db.read<{ unread: number }>(UNREAD_SQL, [accountId]);
  return result.rows[0]?.unread ?? 0;
}

/** The unread count and the newest unread notification's ID (null when none is unread). */
export async function readUnreadNewest(db: ReadableDatabase, accountId: string): Promise<SocialNotificationUnreadNewest> {
  const result = await db.read<{ unread: number; newest: string | null }>(UNREAD_NEWEST_SQL, [accountId]);
  const row = result.rows[0];
  return { unread_count: row?.unread ?? 0, newest_unread_id: row?.newest ?? null };
}

/** One page of `accountId`'s notifications (no unread count). */
export async function readNotificationItems(
  db: ReadableDatabase,
  accountId: string,
  page: NotificationPageRequest,
  nowMs: number,
): Promise<Pick<SocialNotificationPage, "items" | "next_cursor">> {
  const result = await db.read<NotificationRow>(PAGE_SQL, [
    accountId,
    page.before?.occurredAtMs ?? null,
    page.before?.id ?? null,
    page.limit + 1,
  ]);
  const rows = result.rows.slice(0, page.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => renderNotification(row, nowMs)),
    next_cursor:
      result.rows.length > page.limit && last ? encodeNotificationCursor({ occurredAtMs: Number(last.occurred_at_ms), id: last.id }) : null,
  };
}

/** A page with the unread count (two statements, which may run concurrently on separate connections). */
export async function readNotificationPage(
  db: ReadableDatabase,
  accountId: string,
  page: NotificationPageRequest,
  nowMs: number,
): Promise<SocialNotificationPage> {
  const [items, unread] = await Promise.all([readNotificationItems(db, accountId, page, nowMs), readUnreadCount(db, accountId)]);
  return { ...items, unread_count: unread };
}

/** Marks `notificationId` read if it is `accountId`'s; false when it is not (or does not exist). Idempotent. */
export async function markNotificationRead(
  social: ModuleTransaction<"social">,
  accountId: string,
  notificationId: string,
): Promise<boolean> {
  const updated = await social.write(
    "social_notifications",
    `UPDATE social_notifications SET read_at = COALESCE(read_at, now())
     WHERE account_id = $1 AND notification_id = $2::bigint`,
    [accountId, notificationId],
  );
  return updated.rowCount === 1;
}

/**
 * Advances the account's watermark through the last fetched ID. An unbounded
 * write from an older client uses the account's newest unread ID.
 */
export async function markNotificationsRead(social: ModuleTransaction<"social">, accountId: string, through: string | null): Promise<void> {
  await social.write(
    "social_notification_reads",
    `INSERT INTO social_notification_reads AS reads (account_id, read_through)
     SELECT $1, COALESCE(max(n.notification_id), 0) FROM social_notifications n
     WHERE n.account_id = $1 AND n.read_at IS NULL AND ($2::bigint IS NULL OR n.notification_id <= $2)
     ON CONFLICT (account_id) DO UPDATE
       SET read_through = greatest(reads.read_through, EXCLUDED.read_through), updated_at = now()`,
    [accountId, through],
  );
}
