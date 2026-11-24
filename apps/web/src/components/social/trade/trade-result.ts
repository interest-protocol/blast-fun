import { amtExact, exactAtoms, ZERO_EXACT } from "@blast/core/web/exact-amount.ts";
import type { SocialTrade } from "@blast/core/web/contracts/trades.ts";

import type { TradeCoins } from "./trade-kit";

/**
 * What a finished trade says (FEATURE-MAP-R3 §14.1, the gate's
 * `executeTrade`): the toast `Traded 100 USDC for 47,566 KSTL` with the route
 * string under it, from the trade the route answered — what was sent and what
 * **filled**, never the quote's estimate once the chain has spoken.
 */

export type TradeToast = Readonly<{ title: string; sub: string | null }>;

/** A trade the chain confirmed: what went in and what filled. */
export function tradedToast(trade: SocialTrade, coins: TradeCoins) {
  const got = exactAtoms(trade.amount_out_filled, coins.out.decimals) ?? exactAtoms(trade.amount_out, coins.out.decimals) ?? ZERO_EXACT;
  const sent = exactAtoms(trade.amount_in, coins.in.decimals) ?? ZERO_EXACT;
  const first = { symbol: coins.in.symbol, iconUrl: coins.in.iconUrl, coinType: trade.in_coin, amount: amtExact(sent) };
  const second = { symbol: coins.out.symbol, iconUrl: coins.out.iconUrl, coinType: trade.out_coin, amount: amtExact(got) };
  return {
    title: `Traded ${first.amount} ${first.symbol} for ${second.amount} ${second.symbol}`,
    sub: trade.route_label,
    first,
    second,
  };
}

/**
 * A trade that was sent but that the chain does not show yet (R3-31's
 * `pending`): it is not called filled, because nothing says so yet; the
 * transaction log settles it from the chain. The coins sheet's words (R3-33),
 * so both surfaces say the same.
 */
export function sentToast(): TradeToast {
  return { title: "Trade sent", sub: "Your coins update when it lands" };
}
