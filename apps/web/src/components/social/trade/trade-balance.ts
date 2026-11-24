/** What a trade says when the wallet cannot cover it: the coin or the network fee it lacks. */

import { exactAtoms, exactText, groupDigits } from "@blast/core/web/exact-amount.ts";
import type { SocialTradeBalanceFailure } from "@blast/core/web/contracts/trades.ts";

export function tradeBalanceMessage(failure: SocialTradeBalanceFailure, symbol: string, decimals: number): string {
  const gas = failure.reason === "gas";
  const asset = gas ? "native SUI for the network fee" : symbol;
  const required = exactAtoms(failure.required_atoms, gas ? 9 : decimals);
  const amount = required === null ? "0" : groupDigits(exactText(required));
  return `Not enough ${asset}. Your wallet needs at least ${amount} ${gas ? "SUI" : symbol}. ${gas ? "Add SUI and try again." : "Check the amount."}`;
}

export function tradeBalanceLabel(failure: SocialTradeBalanceFailure | null | undefined, symbol: string): string {
  return failure?.reason === "gas" ? "Add SUI to trade" : `Not enough ${symbol}`;
}
