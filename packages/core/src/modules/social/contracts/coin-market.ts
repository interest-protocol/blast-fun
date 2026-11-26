import type {
  HomeWire,
  homeMarketWindowSchema,
  homeCoinMarketReadModelSchema,
  homeHolderPositionSchema,
  homeHoldersReadModelSchema,
  homeChartTradeSchema,
  homeChartTradesPageSchema,
} from "./home-schemas.ts";
import type { z } from "zod";

/**
 * One coin's market, holders and chart trades for the Blast mode workspace
 * and the coin page (redesign data gaps 1, 2, 3, 7, 8 and 10). Public reads on
 * the replica through `chain_read_v1` views, like Home's, and one viewer read
 * on the primary.
 *
 * - `GET /api/social/home/market?coin=<coin type>`: the coin's price, its move
 *   and buy/sell pressure over `5m`, `1h`, `4h` and `24h`, its FDV and market
 *   cap, and its pool's reserves and liquidity (`HomeCoinMarket`).
 * - `GET /api/social/home/holders?coin=<coin type>&limit=`: the coin's largest
 *   holders (an account's wallets summed) with each one's cost basis: what it
 *   paid for what it holds, its average entry, value and P&L
 *   (`HomeHoldersPage`). `limit` 1 to `HOME_HOLDERS_MAX`, default
 *   `HOME_HOLDERS_DEFAULT`.
 * - `GET /api/social/home/trades?coin=&from_ms=&to_ms=&min_usd=`: the coin's
 *   trades of at least `min_usd` (default and minimum
 *   `HOME_BIG_TRADE_USD`) in `(from_ms, to_ms]`, newest first, at most
 *   `HOME_CHART_TRADES_MAX`: the chart's "Big trades" overlay
 *   (`HomeChartTradesPage`).
 * - `GET /api/social/me/home/trades?coin=&from_ms=&to_ms=`: the signed-in
 *   viewer's own trades of the coin from every wallet linked to the account,
 *   same shape: the chart's "My swaps" overlay. Account required,
 *   `private, no-store`.
 *
 * The public answers are the same for every caller and a 200 is publicly
 * cached for ten seconds (`s-maxage=10`), as Home's are; the live-hints
 * stream tells a page when to read again. Every read is bounded by the
 * watermark: trades up to the market pipeline's committed checkpoint and
 * nothing after the chain clock (`clock_ms`).
 *
 * **Coverage.** Trades are `chain_read_v1.activity`'s `trade_buy` and
 * `trade_sell` rows. blast-infra reads a sale coin's trades from each
 * transaction's balance changes, never from one pool's events, so they are
 * every buy and sell of the coin on any venue and route: its migration pool,
 * any other Cetus, Bluefin or Aftermath pool, an aggregator. Each row names
 * its venue (`other` for a route across pools). The pressure and volumes are
 * therefore across venues; an arbitrage that leaves the sender's balance of
 * the coin unchanged is no trade. A standalone vault coin's trades are the
 * swaps of its registered pool only.
 *
 * **Missing figures** are null (or absent), never 0: a window with no
 * price at its start has no move, a side with no priced trade has no USD.
 */

export const SOCIAL_HOME_MARKET_ROUTE = "GET /api/social/home/market";
export const SOCIAL_HOME_MARKET_PATH = "/api/social/home/market";
export const SOCIAL_HOME_HOLDERS_ROUTE = "GET /api/social/home/holders";
export const SOCIAL_HOME_HOLDERS_PATH = "/api/social/home/holders";
export const SOCIAL_HOME_TRADES_ROUTE = "GET /api/social/home/trades";
export const SOCIAL_HOME_TRADES_PATH = "/api/social/home/trades";
export const SOCIAL_HOME_MY_TRADES_ROUTE = "GET /api/social/me/home/trades";
export const SOCIAL_HOME_MY_TRADES_PATH = "/api/social/me/home/trades";

/** The market's windows, shortest first, and their lengths. */
export const HOME_MARKET_WINDOWS = ["5m", "1h", "4h", "24h"] as const;
export type HomeMarketWindowName = (typeof HOME_MARKET_WINDOWS)[number];
export const HOME_MARKET_WINDOW_MS: Readonly<
  Record<HomeMarketWindowName, number>
> = Object.freeze({
  "5m": 300_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "24h": 86_400_000,
});

/** One window `(from_ms, to_ms]` of the coin's market. */
export type HomeMarketWindow = HomeWire<z.infer<typeof homeMarketWindowSchema>>;

export type HomeCoinMarket = HomeWire<
  z.infer<typeof homeCoinMarketReadModelSchema>
>;

/** The holders read's page sizes. */
export const HOME_HOLDERS_DEFAULT = 50;
export const HOME_HOLDERS_MAX = 100;

/**
 * One holder with its cost basis, measured against its balance by the
 * portfolio's rule (`portfolio/cost-basis.ts`, the same figures a profile
 * shows): `basis_usd` what it paid for what it holds, `pnl_usd` and
 * `pnl_multiple` at the coin's fresh price. `average_entry_usd` is the
 * basis per whole token, twelve significant digits, null whenever the basis
 * is incomplete. `value_usd` is the balance at the price now, two places.
 * Only a sale's coin has a basis (its trades carry the sale): every holder
 * of a standalone vault coin answers the unknown basis.
 */
export type HomeHolderPosition = HomeWire<
  z.infer<typeof homeHolderPositionSchema>
>;

export type HomeHoldersPage = HomeWire<
  z.infer<typeof homeHoldersReadModelSchema>
>;

/**
 * Trades under this many dollars are dust: the trades lists hide them, and
 * they never become a post or the coin page's Last-trade pill.
 */
export const SMALL_TRADE_USD = 1;
/**
 * Trades under this many dollars are tiny: no trades list shows them and no
 * buy, sell, buyer or trade count counts them, with the switch on or off.
 * Volume still sums them. Jose's ruling, 2026-11-26.
 */
export const TINY_TRADE_USD = "0.01";
/** The chart's "Big trades": trades of at least this many dollars. */
export const HOME_BIG_TRADE_USD = 1_000;
/** The most trades one chart page carries, newest first. */
export const HOME_CHART_TRADES_MAX = 200;
/** The longest span one chart page covers (the chart's longest window). */
export const HOME_CHART_TRADES_SPAN_MS = 30 * 86_400_000;

/** One trade on the chart: when, which side, how much, and who (named by the naming rule at its time). */
export type HomeChartTrade = HomeWire<z.infer<typeof homeChartTradeSchema>>;

export type HomeChartTradesPage = HomeWire<
  z.infer<typeof homeChartTradesPageSchema>
>;

/** `GET /api/social/home/market` for one coin. */
export function socialHomeMarketPath(coinType: string): string {
  return `${SOCIAL_HOME_MARKET_PATH}?${new URLSearchParams({ coin: coinType }).toString()}`;
}

/** `GET /api/social/home/holders` for one coin. */
export function socialHomeHoldersPath(
  coinType: string,
  limit: number = HOME_HOLDERS_DEFAULT,
): string {
  const params = new URLSearchParams({ coin: coinType });
  if (limit !== HOME_HOLDERS_DEFAULT) params.set("limit", String(limit));
  return `${SOCIAL_HOME_HOLDERS_PATH}?${params.toString()}`;
}

/** `GET /api/social/home/trades` (big trades) or, with `mine`, `GET /api/social/me/home/trades`. */
export function socialHomeChartTradesPath(
  coinType: string,
  fromMs: number,
  toMs: number,
  mine = false,
): string {
  const params = new URLSearchParams({
    coin: coinType,
    from_ms: String(fromMs),
    to_ms: String(toMs),
  });
  return `${mine ? SOCIAL_HOME_MY_TRADES_PATH : SOCIAL_HOME_TRADES_PATH}?${params.toString()}`;
}
