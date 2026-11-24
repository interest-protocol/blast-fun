import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

import { goldFigures } from "../profile/profile-model";

/**
 * The whole portfolio's move today (OA-41): one model for every place that
 * shows it — the rail's Portfolio row and the phone top bar's pill (R3-73),
 * the Portfolio page's hero (R3-74) and Blast mode's dock (R3-58). Moved here
 * from the dock's model, unchanged. The inputs are the product's reads only:
 * the portfolio (`GET /api/social/me/portfolio`) and R3-20's prices
 * (`GET /api/social/prices`: each held sale coin's price now and at the day's
 * open, SUI's 24 h move). **Null unless every input is known**; then there is
 * no `today` line anywhere, never an estimate.
 */

import { todayMove, type DayCoin } from "@blast/core/modules/social/portfolio/today.ts";
export { todayMove, type DayCoin } from "@blast/core/modules/social/portfolio/today.ts";

/**
 * Today's move from the reads (R3-20, the gate's `dockToday`): every sale coin
 * the portfolio holds at its price now and at the day's open (00:00 UTC), and
 * SUI at its 24 h move, against the portfolio's total. A coin's quantity is
 * its value over its price, so its move is in dollars without its decimals.
 * **Null unless every input is known**: one held coin without a price or a
 * day-open price, or SUI without a 24 h move, and there is no line.
 */
export function dockToday(
  portfolio: SocialPortfolio | null,
  prices: readonly SocialPriceHistory[],
  sui: SocialPriceHistory | null | undefined,
): Readonly<{ usd: number; pct: number }> | null {
  if (portfolio?.coin_summary) return portfolio.coin_summary.today;
  if (portfolio === null || portfolio.coins === null || portfolio.balances === null) return null;
  const byCoin = new Map(prices.map((price) => [price.coin_type, price]));
  const coins: DayCoin[] = [];
  for (const coin of portfolio.coins) {
    const price = byCoin.get(coin.coin_type);
    const value = coin.value_usd === null ? null : Number(coin.value_usd);
    const now = price?.price_usd == null ? null : Number(price.price_usd);
    const open = price?.day_open_usd == null ? null : Number(price.day_open_usd);
    if (value === null || now === null || open === null || !(now > 0)) return null;
    coins.push({ held: value / now, now, dayOpen: open });
  }
  const suiUsd = portfolio.balances.sui.usd === null ? null : Number(portfolio.balances.sui.usd);
  const change = sui?.change_24h_bps ?? null;
  if (suiUsd === null || change === null) return null;
  return todayMove(coins, { usd: suiUsd, change24hPct: change / 100 }, goldFigures(portfolio).total);
}
