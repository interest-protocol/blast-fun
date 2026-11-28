import { timed } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  isNotificationId,
  NOTIFICATION_UNREAD_NEWEST_PARAMETER,
  notificationIdSchema,
  SOCIAL_NOTIFICATION_READ_ROUTE,
  SOCIAL_NOTIFICATIONS_READ_ALL_ROUTE,
  SOCIAL_NOTIFICATIONS_ROUTE,
  SOCIAL_NOTIFICATIONS_UNREAD_ROUTE,
  type SocialNotificationUnread,
} from "@blast/core/modules/social/contracts/notifications.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { z } from "zod";
import { readSocialBody, type SocialRouteKit } from "../route-kit/route.ts";
import { socialInput } from "../route-kit/validation.ts";
import {
  markNotificationRead,
  markNotificationsRead,
  parseNotificationPage,
  readNotificationPage,
  readUnreadCount,
  readUnreadNewest,
} from "./store.ts";

export type SocialNotificationRoutesDependencies = Readonly<{
  kit: SocialRouteKit;
  /** Standalone reads on the primary (so a mark-read reads back at once). Without it reads run in a kit transaction. */
  database?: () => ReadableDatabase;
  now?: () => number;
}>;

/** A mark-read takes no body: an empty one or `{}` only. */
async function emptyBody(request: Request): Promise<void> {
  const body = new TextDecoder().decode(await readSocialBody(request, 64)).trim();
  if (body !== "" && body !== "{}") throw new SocialRouteError("invalid_request");
}

const readAllBody = z.strictObject({ through: notificationIdSchema });

async function notificationReadThrough(request: Request): Promise<string | null> {
  const body = await readSocialBody(request, 64);
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body).trim();
    if (text === "" || text === "{}") return null;
    if (type !== "application/json") throw new SocialRouteError("invalid_request");
    value = JSON.parse(text);
  } catch {
    throw new SocialRouteError("invalid_request");
  }
  return socialInput(readAllBody, value).through;
}

/**
 * The notification routes (contract in `contracts/notifications.ts`): the
 * signed-in account's own rows only, keyed by the account the kit resolved
 * (never by a provider identity), `Cache-Control: private, no-store`.
 *
 * - The page and the writes count in `social_notification` (per account).
 * - The unread count counts in `social_me_read`, like the account's other
 *   own reads. The shell reads it on load and focus; a visible tab polls it
 *   with `?newest=1` every minute to spot new alerts. The newest ID is the
 *   same capped index scan read backwards, in the same statement.
 *
 * Metrics: `social.notifications` with `operation` (`page`, `unread`,
 * `unread_newest`, `read`, `read_all`) through `timed`, sampled for reads.
 */
export function createSocialNotificationRoutes(dependencies: SocialNotificationRoutesDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;

  function read<Result>(
    context: Parameters<Parameters<SocialRouteKit["route"]>[1]>[0],
    label: string,
    operation: (db: ReadableDatabase) => Promise<Result>,
  ): Promise<Result> {
    return database ? operation(database()) : context.transaction((social) => operation(social), { label });
  }

  return Object.freeze({
    page: Object.freeze({
      GET: kit.route(
        { name: SOCIAL_NOTIFICATIONS_ROUTE, auth: "account", account: "required", bucket: "social_notification", cache: "private" },
        async (context) => {
          const page = parseNotificationPage(new URL(context.request.url).searchParams);
          const accountId = context.account!.account_id;
          const body = await timed(
            "social.notifications",
            () => read(context, "social.notifications_page", (db) => readNotificationPage(db, accountId, page, now())),
            { operation: "page" },
            { sampleRate: 0.1 },
          );
          return context.json(body);
        },
      ),
    }),
    unread: Object.freeze({
      GET: kit.route(
        { name: SOCIAL_NOTIFICATIONS_UNREAD_ROUTE, auth: "account", account: "required", bucket: "social_me_read", cache: "private" },
        async (context) => {
          const accountId = context.account!.account_id;
          if (new URL(context.request.url).searchParams.get(NOTIFICATION_UNREAD_NEWEST_PARAMETER) === "1") {
            const body = await timed(
              "social.notifications",
              () => read(context, "social.notifications_unread", (db) => readUnreadNewest(db, accountId)),
              { operation: "unread_newest" },
              { sampleRate: 0.05 },
            );
            return context.json(body);
          }
          const unread = await timed(
            "social.notifications",
            () => read(context, "social.notifications_unread", (db) => readUnreadCount(db, accountId)),
            { operation: "unread" },
            { sampleRate: 0.05 },
          );
          return context.json({ unread_count: unread } satisfies SocialNotificationUnread);
        },
      ),
    }),
    /** `POST …/{id}/read`: the id is the path's second-to-last segment. */
    markRead: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_NOTIFICATION_READ_ROUTE, auth: "account", account: "required", bucket: "social_notification", cache: "private" },
        async (context) => {
          await emptyBody(context.request);
          const id = new URL(context.request.url).pathname.split("/").at(-2) ?? "";
          if (!isNotificationId(id)) throw new SocialRouteError("not_found");
          const accountId = context.account!.account_id;
          const unread = await timed(
            "social.notifications",
            () =>
              context.transaction(async (social) => {
                if (!(await markNotificationRead(social, accountId, id))) throw new SocialRouteError("not_found");
                return readUnreadCount(social, accountId);
              }, { label: "social.notifications_read" }),
            { operation: "read" },
          );
          return context.json({ unread_count: unread } satisfies SocialNotificationUnread);
        },
      ),
    }),
    readAll: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_NOTIFICATIONS_READ_ALL_ROUTE, auth: "account", account: "required", bucket: "social_notification", cache: "private" },
        async (context) => {
          const through = await notificationReadThrough(context.request);
          const accountId = context.account!.account_id;
          const unread = await timed(
            "social.notifications",
            () =>
              context.transaction(async (social) => {
                await markNotificationsRead(social, accountId, through);
                return readUnreadCount(social, accountId);
              }, { label: "social.notifications_read_all" }),
            { operation: "read_all" },
          );
          return context.json({ unread_count: unread } satisfies SocialNotificationUnread);
        },
      ),
    }),
  });
}
