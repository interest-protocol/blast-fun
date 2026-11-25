import type { SocialBuyAlert } from "@blast/core/modules/social/contracts/buy-alerts.ts";
import { readableUsd } from "#web/lib/market-format.ts";

/** How long a card stays, not counting time hovered, focused, dragged or in a hidden tab. */
export const ALERT_LIFE_MS = 5_000;
/** An upward drag this far, or a flick faster than `SWIPE_VELOCITY` px/ms, dismisses. */
export const SWIPE_DISTANCE_PX = 36;
export const SWIPE_VELOCITY = 0.11;

/** The card's line: who, what, how much, and the cap when known. */
export function buyAlertText(alert: SocialBuyAlert): Readonly<{ name: string; amount: string | null; symbol: string; cap: string | null }> {
  return {
    name: alert.actor.display_name ?? alert.actor.callsign,
    amount: alert.usd === null ? null : readableUsd(alert.usd),
    symbol: alert.coin.symbol,
    cap: alert.market_cap_usd === null ? null : readableUsd(alert.market_cap_usd),
  };
}
