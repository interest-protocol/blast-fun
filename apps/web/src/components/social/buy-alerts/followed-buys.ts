import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { socialBuyAlertPath, socialBuyAlertResponseSchema, type SocialBuyAlert } from "@blast/core/modules/social/contracts/buy-alerts.ts";

import { isTradeUnderDollar } from "#web/components/launchpad/activity/small-trades.ts";

import { presaleHref } from "../feed-ui/shell-bridge-model";
import type { FreshnessHint } from "../home/feed-freshness";

/**
 * Followed buy alerts, browser side. The tab already holds the public
 * activity hints; each hint names its trade's wallet (`actor`). This tab
 * keeps the wallets of the people the viewer follows and drops every other
 * hint, so the server does no per-viewer work when a trade lands.
 *
 * A kept hint waits a random share of `ALERT_SPREAD_MS` (one buy reaches
 * every follower's tab at once; the card reads then spread), then reads the
 * trade's public card. A `null` card (a private account, a wallet no longer
 * named) or a `404` (no row or coin yet, a hidden sale) shows nothing. The
 * card must name the hint's wallet. A buy under $1 shows nothing, as the
 * trades list hides it.
 */

/** The followed wallets are read once and stay fresh this long; a follow or unfollow here reads them again. */
export const FOLLOWING_WALLETS_STALE_MS = 10 * 60_000;

/** The card's coin link: the sale's page, or a curve coin's own page. */
export function buyAlertCoinHref(coin: SocialBuyAlert["coin"]): string {
  return coin.presale_id === null ? coinPagePath(coin.coin_type) : presaleHref(coin.presale_id);
}

/** A kept hint's card read waits a uniform share of this long. */
export const ALERT_SPREAD_MS = 2_000;
/** How many trades are remembered, to drop a repeat. */
const REMEMBERED = 256;

/** The trade a hint names when it is a followed wallet's buy, not the viewer's own, else null. */
export function followedBuyOf(
  hint: FreshnessHint,
  followed: ReadonlySet<string>,
  own: ReadonlySet<string>,
): Readonly<{ activityId: string; actor: string }> | null {
  const trade = hint.trade;
  if (hint.cause !== "hint" || !trade || trade.kind !== "trade_buy" || !trade.actor) return null;
  if (!followed.has(trade.actor) || own.has(trade.actor)) return null;
  return { activityId: trade.cursor, actor: trade.actor };
}

export type FollowedBuysDependencies = Readonly<{
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Uniform in [0, 1). */
  random: () => number;
  visible: () => boolean;
  /** The trade's card, or null (no card, a failed read, a malformed answer). */
  readCard: (activityId: string) => Promise<SocialBuyAlert | null>;
  show: (alert: SocialBuyAlert) => void;
}>;

/** Spreads and reads each kept buy once; a later card replaces an earlier one on screen. */
export class FollowedBuys {
  readonly #deps: FollowedBuysDependencies;
  readonly #seen = new Set<string>();
  readonly #waiting = new Set<unknown>();
  #closed = false;

  constructor(dependencies: FollowedBuysDependencies) {
    this.#deps = dependencies;
  }

  /** Takes one kept buy: new trades only, and only while the tab is visible. */
  offer(buy: Readonly<{ activityId: string; actor: string }>): void {
    if (this.#closed || this.#seen.has(buy.activityId) || !this.#deps.visible()) return;
    this.#seen.add(buy.activityId);
    if (this.#seen.size > REMEMBERED) this.#seen.delete(this.#seen.values().next().value as string);
    const wait = Math.floor(Math.min(Math.max(this.#deps.random(), 0), 1) * ALERT_SPREAD_MS);
    const handle = this.#deps.setTimeout(() => {
      this.#waiting.delete(handle);
      void this.#read(buy);
    }, wait);
    this.#waiting.add(handle);
  }

  async #read(buy: Readonly<{ activityId: string; actor: string }>): Promise<void> {
    if (this.#closed || !this.#deps.visible()) return;
    const card = await this.#deps.readCard(buy.activityId).catch(() => null);
    if (this.#closed || card === null || card.wallet !== buy.actor || card.activity_id !== buy.activityId) return;
    if (isTradeUnderDollar({ usd: card.usd })) return;
    if (this.#deps.visible()) this.#deps.show(card);
  }

  /** Stops every wait; reads in flight show nothing. */
  close(): void {
    this.#closed = true;
    for (const handle of this.#waiting) this.#deps.clearTimeout(handle);
    this.#waiting.clear();
  }
}

/** The public card read: the edge may answer from cache (`s-maxage=10`); `null` when there is no card. */
export async function readBuyAlertCard(activityId: string, fetchImpl: typeof fetch = fetch): Promise<SocialBuyAlert | null> {
  const response = await fetchImpl(socialBuyAlertPath(activityId), { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const parsed = socialBuyAlertResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : null;
}
