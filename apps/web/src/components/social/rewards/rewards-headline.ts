import { amountsText, type RewardCoinView } from "./rewards-model";

/**
 * The side card's figure: what came in across coins at today's prices
 * ("$18.40", "<$0.01"), or with no price known the first coin's amounts; the
 * coins without a price follow in the line beneath (`grandText`'s parts).
 */
export function rewardsHeadline(coins: readonly RewardCoinView[]): Readonly<{ figure: string; priced: boolean; rest: readonly string[] }> {
  const known = coins.filter((coin) => coin.usd !== null);
  const unknown = coins.filter((coin) => coin.usd === null).map((coin) => amountsText(coin.received, coin.symbol, coin.quoteSymbol));
  if (known.length === 0) return { figure: unknown[0] ?? "", priced: false, rest: unknown.slice(1) };
  const total = known.reduce((sum, coin) => sum + (coin.usd ?? 0), 0);
  return { figure: total > 0 && total < 0.01 ? "<$0.01" : `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, priced: true, rest: unknown };
}
