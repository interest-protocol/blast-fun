import { isNotificationId } from "@blast/core/web/contracts/notifications.ts";

/**
 * Spots new alerts from the newest unread ID alone. The first answer, and any
 * answer while not announcing, only moves the starting point. An ID above
 * every ID seen so far is an arrival, even when the unread count stays the
 * same (one alert read while another arrives). Reading the newest alert lowers
 * the ID, which is never an arrival; so is an alert stored with an ID below
 * one already seen (it shows in the count and the list, without a pop).
 */
export function notificationArrivals() {
  let highest: bigint | null = null;
  return (newestUnreadId: string | null, announce: boolean): boolean => {
    const newest = newestUnreadId !== null && isNotificationId(newestUnreadId) ? BigInt(newestUnreadId) : null;
    const arrived = announce && highest !== null && newest !== null && newest > highest;
    if (highest === null || (newest !== null && newest > highest)) highest = newest ?? 0n;
    return arrived;
  };
}
