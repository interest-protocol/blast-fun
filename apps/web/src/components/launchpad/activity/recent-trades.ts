import { isActivityTrade, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { RECENT_TRADES_LIMIT } from "@blast/core/modules/social/contracts/trader-profiles.ts";

export function recentTrades(rows: readonly ActivityRow[]): ActivityRow[] {
  return rows.filter(isActivityTrade).slice(0, RECENT_TRADES_LIMIT);
}
