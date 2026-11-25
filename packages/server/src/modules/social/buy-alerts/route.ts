import { z } from "zod";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  ACTIVITY_ID_PATTERN,
  SOCIAL_BUY_ALERT_PREFIX,
  SOCIAL_BUY_ALERT_ROUTE,
  SOCIAL_BUY_ALERT_SUFFIX,
  SOCIAL_FOLLOWING_WALLETS_ROUTE,
} from "@blast/core/modules/social/contracts/buy-alerts.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

import { readBuyAlert, readFollowingWallets } from "./read.ts";

export type SocialBuyAlertRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary in production: a follow just written counts. Resolved per request. */
  primary: () => ReadableDatabase;
  /** The read replica in production (`socialFeedDatabase`). Resolved per request. */
  replica: () => ReadableDatabase;
}>;

/** The `{activity_id}` of an alert path, or `invalid_parameter`. */
export function alertActivityId(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const raw = pathname.startsWith(SOCIAL_BUY_ALERT_PREFIX) && pathname.endsWith(SOCIAL_BUY_ALERT_SUFFIX)
    ? pathname.slice(SOCIAL_BUY_ALERT_PREFIX.length, -SOCIAL_BUY_ALERT_SUFFIX.length)
    : "";
  let value: string | null = null;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = null;
  }
  const parsed = z.string().regex(ACTIVITY_ID_PATTERN).safeParse(value);
  if (!parsed.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "activity_id" } });
  return parsed.data;
}

/**
 * The followed buy alert routes (contract in `contracts/buy-alerts.ts`):
 * the caller's followed wallets (private) and one trade's card (public,
 * cached 10 s; `null` unless a named buy of a shown coin, and while trades are
 * hidden, so misses coalesce at the edge too; an id with no row yet is a
 * no-store 404).
 */
export function createSocialBuyAlertRoutes(dependencies: SocialBuyAlertRouteDependencies) {
  const { kit, primary, replica } = dependencies;
  return Object.freeze({
    wallets: Object.freeze({
      GET: kit.route(
        { name: SOCIAL_FOLLOWING_WALLETS_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
        async (context) => context.json(await readFollowingWallets(primary(), context.account!.account_id)),
      ),
    }),
    alert: Object.freeze({
      GET: kit.route(
        { name: SOCIAL_BUY_ALERT_ROUTE, auth: "none", bucket: "social_read", cache: "public-fresh" },
        async (context) => {
          const activityId = alertActivityId(context.request);
          return context.json(context.hiddenKinds.includes("trade_buy") ? null : await readBuyAlert(replica(), activityId));
        },
      ),
    }),
  });
}
