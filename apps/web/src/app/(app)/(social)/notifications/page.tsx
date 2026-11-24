import type { Metadata } from "next";

import { NotificationsScreen } from "#web/components/social/notifications/NotificationsScreen.tsx";

export const metadata: Metadata = { title: "Notifications", robots: { index: false, follow: false } };

/**
 * `/notifications` (canonical UI §13): the signed-in account's own
 * notifications, read in the browser with the viewer's credentials (personal
 * data, never server-rendered or cached). The social layout already answers
 * not-found while the social feed is off. The right column is the
 * Watchlist (`@rail/notifications`, UI-12).
 */
export default function NotificationsPage() {
  return <NotificationsScreen />;
}
