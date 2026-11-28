import { z } from "zod";
import {
  NOTIFICATION_UNREAD_NEWEST_PARAMETER,
  SOCIAL_NOTIFICATIONS_PATH,
  SOCIAL_NOTIFICATIONS_READ_ALL_PATH,
  SOCIAL_NOTIFICATIONS_UNREAD_PATH,
  socialNotificationUnreadNewestSchema,
  socialNotificationUnreadSchema,
  socialNotificationWirePageSchema,
  type SocialNotificationPage,
  type SocialNotificationUnread,
  type SocialNotificationUnreadNewest,
} from "@blast/core/web/contracts/notifications.ts";

import {
  callSocialApi,
  type ApiResult,
  type SocialApiOptions,
} from "#web/components/social/social-api.ts";

/**
 * The notifications page's and the shell badge's calls (contract in
 * `contracts/notifications.ts`), through the shared social call
 * (`callSocialApi`): the viewer's own credentials, never cached.
 */

export function fetchNotifications(
  options: SocialApiOptions,
  cursor: string | null = null,
): Promise<ApiResult<SocialNotificationPage>> {
  const path = cursor
    ? `${SOCIAL_NOTIFICATIONS_PATH}?cursor=${encodeURIComponent(cursor)}`
    : SOCIAL_NOTIFICATIONS_PATH;
  return callSocialApi(options, path, { method: "GET" }, socialNotificationWirePageSchema);
}

export function fetchUnreadCount(
  options: SocialApiOptions,
): Promise<ApiResult<SocialNotificationUnread>> {
  return callSocialApi(
    options,
    SOCIAL_NOTIFICATIONS_UNREAD_PATH,
    { method: "GET" },
    socialNotificationUnreadSchema,
  );
}

/** A backend from before `?newest=1` answers the count alone; the poll then only updates the count. */
const unreadNewestOrCountSchema = z.union([socialNotificationUnreadNewestSchema, socialNotificationUnreadSchema]);

/** The count and the newest unread ID: the small read a visible tab polls to spot new alerts. */
export function fetchUnreadNewest(
  options: SocialApiOptions,
): Promise<ApiResult<SocialNotificationUnread & Partial<SocialNotificationUnreadNewest>>> {
  return callSocialApi(
    options,
    `${SOCIAL_NOTIFICATIONS_UNREAD_PATH}?${NOTIFICATION_UNREAD_NEWEST_PARAMETER}=1`,
    { method: "GET" },
    unreadNewestOrCountSchema,
  );
}

export function markNotificationsSeen(
  options: SocialApiOptions,
  through: string,
): Promise<ApiResult<SocialNotificationUnread>> {
  return callSocialApi(
    options,
    SOCIAL_NOTIFICATIONS_READ_ALL_PATH,
    { method: "POST", body: { through } },
    socialNotificationUnreadSchema,
  );
}
