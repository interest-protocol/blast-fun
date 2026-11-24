import { SOCIAL_FEED_DELAYED_LAG_MS } from "@blast/core/web/contracts/feed.ts";
import type { AsOf } from "@blast/core/web/contracts/items.ts";

/**
 * The feed's delay rule. Amounts, prices and times are the shell's
 * (`blast-ui/format.ts`); post formats are `post/post-format.ts`.
 */

/** Whether the feed should say "Activity is delayed": the slowest pipeline is over 60 s behind. */
export function isFeedDelayed(asOf: AsOf | null | undefined): boolean {
  return (asOf?.lag_ms ?? 0) > SOCIAL_FEED_DELAYED_LAG_MS;
}
