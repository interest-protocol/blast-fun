import {
  SOCIAL_NOTIFICATIONS_PATH,
  SOCIAL_NOTIFICATIONS_READ_ALL_PATH,
  SOCIAL_NOTIFICATIONS_UNREAD_PATH,
  socialNotificationUnreadSchema,
  socialNotificationWirePageSchema,
  type SocialNotificationPage,
  type SocialNotificationUnread,
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
