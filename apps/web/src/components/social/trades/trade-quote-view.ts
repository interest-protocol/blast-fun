import type { SocialTradeQuote } from "@blast/core/web/contracts/trades.ts";

/**
 * The quote's words that every trade surface shares (FEATURE-MAP-R3 §14.1 and
 * §15.7.5), so the coins sheet (R3-33), the sale page's bar (R3-34) and Blast
 * mode's composer (R3-55) say the same thing about the same quote. Pure: the
 * surfaces own layout, amounts' formatting and timers.
 */

/** The gate's impact text: `<0.01%` below one basis point, else the percentage with trailing zeros trimmed (`0.11%`, `3%`). */
export function impactText(bps: number): string {
  if (bps < 1) return "<0.01%";
  const whole = Math.floor(bps / 100);
  const cents = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${cents ? `.${cents}` : ""}%`;
}

/** The gate's impact colour: red above 10%, amber above 3%, plain otherwise (`--down`, `--warn`). */
export function impactTone(bps: number): "down" | "warn" | "plain" {
  return bps > 1_000 ? "down" : bps > 300 ? "warn" : "plain";
}

/** Whether the quote can still be executed at `nowMs` (it has a `quote_id` that has not expired). */
export function isOffered(quote: SocialTradeQuote, nowMs: number): boolean {
  return quote.quote_id !== null && quote.expires_at_ms !== null && nowMs < quote.expires_at_ms;
}

/** How long a surface may show the quote before asking again: until 2 s before it expires, at least 1 s. */
export const REQUOTE_MARGIN_MS = 2_000;
export function requoteInMs(quote: SocialTradeQuote, nowMs: number): number | null {
  if (quote.expires_at_ms === null) return null;
  return Math.max(1_000, quote.expires_at_ms - REQUOTE_MARGIN_MS - nowMs);
}

/**
 * Why the server sealed no offer for the number pressed for, as the line that ends the press: nothing was sent, the
 * estimate stays and the next press asks again. Null for a refusal with no line of its own.
 */
export function sealRefusalLine(quote: SocialTradeQuote, spent: string): string | null {
  if (quote.unavailable_reason !== null) return `${unavailableText(quote.unavailable_reason)}. Nothing was sent.`;
  if (quote.offer_refused !== "insufficient_balance") return null;
  return quote.balance_failure?.reason === "gas" ? "Not enough SUI for the network fee. Nothing was sent." : `Not enough ${spent} for this amount. Nothing was sent.`;
}

/** The gate's line for a quote that has no route, by its published code. */
export function unavailableText(reason: NonNullable<SocialTradeQuote["unavailable_reason"]>): string {
  switch (reason) {
    case "not_tradable":
      return "This coin isn’t trading yet";
    case "no_pool":
      return "No market for this trade yet";
    case "dry_run_failed":
      return "This trade wouldn’t go through right now";
    case "pool_unavailable":
    default:
      return "Couldn’t get a price. Try again";
  }
}
