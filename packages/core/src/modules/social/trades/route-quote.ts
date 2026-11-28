import { exactAtoms, exactDecimal, fixedExact, multiplyExact } from "@blast/core/lib/exact-amount.ts";
import {
  SOCIAL_TRADE_BASE_COINS,
  type SocialTradeHop,
  type SocialTradeQuote,
  type SocialTradeSide,
  type SocialTradeUnavailableReason,
} from "@blast/core/modules/social/contracts/trades.ts";
import {
  fractionBps,
  impactFromDeviation,
  minOut,
  routeFeeFraction,
  routeLabel,
  scaleAtoms,
  venueOf,
  type Fraction,
} from "@blast/core/modules/social/trades/amounts.ts";
import type { TradeRoute } from "@blast/core/modules/social/trades/cetus-route.ts";

/**
 * A route's numbers as a quote shows them (social feed R3-30): shared by the
 * server's quote, which then dry-runs and seals it, and the browser's
 * estimate, which shows it as it is. Nothing here reads or asks anything.
 */

/** The pair as asked. */
export type RouteQuoteInput = Readonly<{
  inCoin: string;
  outCoin: string;
  side: SocialTradeSide;
  slippageBps: number;
}>;

/** A coin of the pair: its symbol for the route line, its decimals and USD price (null without one) for the dollar values. */
export type RouteQuoteCoin = Readonly<{ coinType: string; symbol: string; decimals: number; usdPrice: string | null }>;

/** A quote with no number, and why. */
export function unavailableQuote(input: RouteQuoteInput, quotedAtMs: number, reason: SocialTradeUnavailableReason): SocialTradeQuote {
  return {
    quote_id: null,
    expires_at_ms: null,
    quoted_at_ms: quotedAtMs,
    side: input.side,
    in_coin: input.inCoin,
    out_coin: input.outCoin,
    amount_in: null,
    amount_out: null,
    min_out: null,
    slippage_bps: input.slippageBps,
    price_impact_bps: null,
    price_impact_unavailable: null,
    fee_bps: null,
    fee_amount: null,
    blast_fee_bps: null,
    blast_fee_amount: null,
    route: [],
    route_label: null,
    price_per_out: null,
    amount_in_usd: null,
    amount_out_usd: null,
    network_fee: null,
    dry_run: "not_run",
    offer_refused: null,
    unavailable_reason: reason,
  };
}

/** The route's legs as the response lists them. */
function hopsOf(route: TradeRoute): SocialTradeHop[] {
  return route.paths.map((path) => ({
    pool_id: path.poolId,
    venue: venueOf(path.provider),
    in_coin: path.from,
    out_coin: path.target,
    amount_in: path.amountIn.toString(),
    amount_out: path.amountOut.toString(),
  }));
}

/** `atoms` of `coin` in USD to the cent, rounded half up; null without a plain decimal price. */
export function atomsUsd(atoms: bigint, coin: Pick<RouteQuoteCoin, "decimals" | "usdPrice">): string | null {
  const amount = exactAtoms(atoms, coin.decimals);
  const price = exactDecimal(coin.usdPrice);
  return amount === null || price === null ? null : fixedExact(multiplyExact(amount, price), 2);
}

/**
 * The route priced: its amounts, fees, the aggregator's impact (OA-27: its
 * deviation from its market price, net of the route's fees; null where it has
 * none), the route line and the dollar values. Neither offered nor dry-run.
 */
export function priceRoute(
  input: RouteQuoteInput,
  route: TradeRoute,
  coins: Readonly<{ in: RouteQuoteCoin; out: RouteQuoteCoin }>,
  quotedAtMs: number,
  blastFeeBps: number,
): Readonly<{ quote: SocialTradeQuote; fee: Fraction | null; impact: number | null; minOut: bigint }> {
  const fee = routeFeeFraction(route.paths, input.inCoin, route.amountIn, input.outCoin);
  const least = minOut(route.amountOut, input.slippageBps);
  // USDC and SUI are named wherever the route passes through them; any other intermediate is not a Blast coin.
  const symbols = new Map([
    [SOCIAL_TRADE_BASE_COINS.usdc, "USDC"],
    [SOCIAL_TRADE_BASE_COINS.sui, "SUI"],
    [coins.in.coinType, coins.in.symbol],
    [coins.out.coinType, coins.out.symbol],
  ]);
  const impact = fee === null ? null : impactFromDeviation(route.deviationRatio, fee);
  const quote: SocialTradeQuote = {
    quote_id: null,
    expires_at_ms: null,
    quoted_at_ms: quotedAtMs,
    side: input.side,
    in_coin: input.inCoin,
    out_coin: input.outCoin,
    amount_in: route.amountIn.toString(),
    amount_out: route.amountOut.toString(),
    min_out: least.toString(),
    slippage_bps: input.slippageBps,
    price_impact_bps: impact,
    // Until a dry run measures it, a pair without the aggregator's impact has none to show.
    price_impact_unavailable: impact === null ? "no_dry_run" : null,
    fee_bps: fee === null ? null : fractionBps(fee),
    fee_amount: fee === null ? null : scaleAtoms(route.amountIn, fee).toString(),
    blast_fee_bps: blastFeeBps,
    blast_fee_amount: route.blastFee.toString(),
    route: hopsOf(route),
    route_label: routeLabel(route.paths.map((path) => ({ ...path, venue: venueOf(path.provider) })), input.inCoin, input.outCoin, symbols),
    price_per_out: coins.out.usdPrice,
    amount_in_usd: atomsUsd(route.amountIn, coins.in),
    amount_out_usd: atomsUsd(route.amountOut, coins.out),
    network_fee: null,
    dry_run: "not_run",
    offer_refused: null,
    unavailable_reason: null,
  };
  return { quote, fee, impact, minOut: least };
}
