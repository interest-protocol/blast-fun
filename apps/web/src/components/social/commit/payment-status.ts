import type { TradeQuoteSnapshot } from "../trade/trade-quotes.ts";
import { isOffered } from "../trades/trade-quote-view";

export type PaymentStatus = "idle" | "quoting" | "ready" | "no-route" | "temporary-error" | "expired" | "insufficient-balance" | "unsupported" | "submitting";

/** A timeout or unoffered preview never becomes a definitive no-route answer. */
export function paymentStatus(snapshot: TradeQuoteSnapshot, nowMs: number, submitting = false): PaymentStatus {
  if (submitting) return "submitting";
  if (snapshot.key === null) return "idle";
  if (snapshot.loading) return "quoting";
  if (snapshot.error) return snapshot.error.code === "wrong-network" ? "unsupported" : "temporary-error";
  const quote = snapshot.quote;
  if (!quote) return "idle";
  if (quote.unavailable_reason === "no_pool") return "no-route";
  if (quote.unavailable_reason === "not_tradable") return "unsupported";
  if (quote.unavailable_reason) return "temporary-error";
  if (quote.offer_refused === "insufficient_balance") return "insufficient-balance";
  if (quote.expires_at_ms !== null && nowMs >= quote.expires_at_ms) return "expired";
  return isOffered(quote, nowMs) && quote.min_out !== null && BigInt(quote.min_out) > 0n && quote.offer_refused === null ? "ready" : "temporary-error";
}

export function paymentStatusMessage(state: PaymentStatus, symbol: string, target: string): string | null {
  switch (state) {
    case "quoting": return `Finding a route to ${target}…`;
    case "no-route": return `No route from ${symbol} to ${target} for this presale, or insufficient liquidity for this amount. Try another coin or amount.`;
    case "temporary-error": return "Couldn’t get a price. Try again.";
    case "expired": return "Quote expired. Refresh it before contributing.";
    case "insufficient-balance": return `Not enough ${symbol} to pay this amount and network fee.`;
    case "unsupported": return `This asset or network is unsupported for this presale. Choose another payment coin on Sui mainnet.`;
    case "ready": return `The swap and contribution succeed together. Any extra ${target} returns to your wallet.`;
    default: return null;
  }
}
