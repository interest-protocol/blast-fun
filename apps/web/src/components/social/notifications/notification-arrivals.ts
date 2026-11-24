import { isNotificationId, type SocialNotification } from "@blast/core/web/contracts/notifications.ts";

/** Session delivery identities, independent of counts and read-state changes. */
export function notificationArrivals() {
  let baseline: bigint | null = null;
  let highest = 0n;
  const seen = new Set<string>();
  return (items: readonly Pick<SocialNotification, "id" | "read">[], announce: boolean): boolean => {
    const valid = items.filter((item) => isNotificationId(item.id));
    highest = valid.reduce((max, item) => BigInt(item.id) > max ? BigInt(item.id) : max, highest);
    if (baseline === null || !announce) {
      baseline = highest;
      seen.clear();
      return false;
    }
    let arrived = false;
    for (const item of valid) {
      if (BigInt(item.id) <= baseline || seen.has(item.id)) continue;
      seen.add(item.id);
      if (!item.read) arrived = true;
    }
    return arrived;
  };
}
