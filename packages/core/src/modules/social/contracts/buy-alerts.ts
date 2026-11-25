import { z } from "zod";

import { feedItemDefinitions } from "./items.ts";
import { SOCIAL_FOLLOW_LIMIT } from "./follows.ts";

import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Followed buy alerts: when someone a signed-in viewer follows buys a coin,
 * the viewer's open tabs show one small card ("Maya bought $120 of ORBIT").
 *
 * The public activity hint carries the trader's wallet (`actor`). Each tab
 * keeps the wallets of the people it follows and ignores every other hint; on
 * a match it reads the trade's card. Nothing per viewer runs on the server
 * when a trade lands.
 *
 * - `GET /api/social/me/following/wallets`: the wallets of the accounts the
 *   caller follows that the naming rule names now (public, sharing, wallet
 *   linked). Signed-in account required, bucket `social_read`, read on the
 *   primary (a follow just written counts), `private, no-store`. Schema
 *   `following-wallets-response`.
 * - `GET /api/social/activity/{activity_id}/alert`: one trade's card. Public,
 *   no authentication, bucket `social_read`, `public-fresh` (`public,
 *   s-maxage=10`). The card, or `null` unless the row is a named buy of a
 *   coin the web shows (a sale in `SHOWN_PRESALES` or a launch's curve coin),
 *   and `null` while trades are hidden. The null answer is a cached 200, not a
 *   no-store 404, so every follower tab that reads a buy without a card still
 *   coalesces at the edge; a privacy change reaches the edge within 10 s.
 *   `400` for a malformed id. Schema `buy-alert-response`.
 */
export const SOCIAL_FOLLOWING_WALLETS_PATH = "/api/social/me/following/wallets";
export const SOCIAL_FOLLOWING_WALLETS_ROUTE = `GET ${SOCIAL_FOLLOWING_WALLETS_PATH}`;
export const SOCIAL_BUY_ALERT_PREFIX = "/api/social/activity/";
export const SOCIAL_BUY_ALERT_SUFFIX = "/alert";
export const SOCIAL_BUY_ALERT_ROUTE = "GET /api/social/activity/{activity_id}/alert";

/** An activity row's id: `checkpoint:tx_slot:event_slot:part`. The checkpoint has at most 18 digits, so it always fits a bigint. */
export const ACTIVITY_ID_PATTERN = /^(0|[1-9][0-9]{0,17}):(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/;

/** The card's path for one activity row. */
export function socialBuyAlertPath(activityId: string): string {
  return `${SOCIAL_BUY_ALERT_PREFIX}${encodeURIComponent(activityId)}${SOCIAL_BUY_ALERT_SUFFIX}`;
}

const usdSchema = z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)]);

export const socialFollowingWalletsSchema = z
  .strictObject({
    wallets: z
      .array(z.string().regex(SUI_OBJECT_ID_PATTERN))
      .max(SOCIAL_FOLLOW_LIMIT)
      .refine((wallets) => new Set(wallets).size === wallets.length)
      .meta({ uniqueItems: true }),
  })
  .meta({
    title: "Following wallets",
    description:
      "GET /api/social/me/following/wallets 200: the wallets the naming rule names now for the accounts the caller follows (private, never cached).",
  });

export type SocialFollowingWallets = z.infer<typeof socialFollowingWalletsSchema>;

export const socialBuyAlertSchema = z
  .strictObject({
    activity_id: z.string().regex(ACTIVITY_ID_PATTERN),
    occurred_at_ms: feedItemDefinitions.millis,
    actor: feedItemDefinitions.accountActor,
    wallet: z.string().regex(SUI_OBJECT_ID_PATTERN).meta({ description: "The buying wallet: the hint's `actor`." }),
    coin: z.strictObject({
      presale_id: z.xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)]).meta({
        description: "The sale's id; null for a launch's curve coin, whose page is its coin type.",
      }),
      coin_type: z.string().regex(COIN_TYPE),
      symbol: z.string().min(1),
      name: z.string(),
      icon_url: z.xor([z.null(), z.string().min(1)]),
    }),
    usd: usdSchema.meta({ description: "What the buy cost in USD, to the cent; null without a price." }),
    market_cap_usd: usdSchema.meta({ description: "The coin's market cap in USD right after the buy, to the cent; null when unknown." }),
  })
  .meta({
    title: "Buy alert",
    description:
      "One named buy of a shown coin, as the followed buy card shows it.",
  });

export type SocialBuyAlert = z.infer<typeof socialBuyAlertSchema>;

export const socialBuyAlertResponseSchema = z.xor([z.null(), socialBuyAlertSchema]).meta({
  title: "Buy alert response",
  description:
    "GET /api/social/activity/{activity_id}/alert 200: the card, or null when the row has none (public, cached 10 s either way, so the edge coalesces every follower's read). An id with no row yet is a 404 the edge never caches.",
});
