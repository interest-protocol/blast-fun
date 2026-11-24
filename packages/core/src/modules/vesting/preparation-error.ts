/** Only recognized SDK failures become advice. Unknown RPC messages stay server-side. */
export function vestingPreparationReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /Unable to perform gas selection due to insufficient SUI balance/.test(
      message,
    )
  )
    return "insufficient_sui_gas";
  if (
    /not enough coins|insufficient.*coin balance|insufficient balance (?:for coin|of )/i.test(
      message,
    )
  )
    return "insufficient_coin_balance";
  return "preparation_failed";
}

export function preparationMessage(reasons: readonly string[] = []): string {
  if (reasons.includes("sponsorship_unavailable"))
    return "Blast can’t sponsor network gas right now. Retry shortly. Your draft is saved here; no wallet gas was charged.";
  if (reasons.includes("insufficient_sui_gas"))
    return "Your wallet needs more SUI for network gas. Add SUI, then retry. Your draft is saved here.";
  if (reasons.includes("insufficient_coin_balance"))
    return "Your coin balance no longer covers this amount. Check the amount and retry.";
  return "We couldn’t prepare this transaction. Your draft is saved here. Retry preparation.";
}
