import { CREATE_QUOTES, type CreateDraft, type CreateQuote } from "@blast/core/web/contracts/create.ts";
import { bluefinTierSupported } from "@blast/core/modules/social/create/bluefin-options.ts";
import { cetusTiersForQuote } from "@blast/core/modules/social/create/cetus-options.ts";
import { draftQuote, venueTiers } from "@blast/core/modules/social/create/model.ts";

import type { CreateState } from "./create-store";

/**
 * R3-42: the "Raise in" picker's words and coins (`QuotePicker.tsx` draws
 * them), apart from the component so Fast Refresh keeps its state.
 */

/** The gate's copy, verbatim (R3-86: oa41's `openQuotePicker`, its footer under the grouped list). */
export const QUOTE_PICKER_COPY = Object.freeze({
  title: "Raise in",
  unchanged: "Amounts kept unchanged. Review them before publishing.",
  converted: "Amounts converted at today’s SUI price",
});

/**
 * R3-86: a pick moves the check at once and the sheet closes a beat later, so
 * the choice is seen to land (oa41's `openQuotePicker`: 240 ms, none under
 * reduced motion).
 */
export function quotePickCloseMs(reduced: boolean): number {
  return reduced ? 0 : 240;
}

/**
 * R3-86: the row ↑ / ↓ moves focus to, as in any radio group: the next or the
 * previous, wrapping. Null for any other key, or when focus is on no row.
 */
export function quoteRowStep(key: string, index: number, count: number): number | null {
  if ((key !== "ArrowDown" && key !== "ArrowUp") || index < 0 || count === 0) return null;
  return (index + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

/** The "Raised in" row's help line for the draft's coin (the gate's `crRow('Raised in', …)`). */
export function quoteRowHelp(symbol: string): string {
  if (symbol === "TEST_SUI" || symbol === "TSUI") return "Fake coins for testing. Buyers pay in TSUI.";
  return symbol === "SUI" ? "Buyers paying in USDC are swapped to SUI for them." : `Buyers paying in SUI are swapped to ${symbol} for them.`;
}

/** The coins the sheet lists, in the gate's order: those offered now, and the draft's own. */
export function pickerQuotes(offered: readonly string[], draft: Pick<CreateDraft, "quote_type">): readonly CreateQuote[] {
  const current = draftQuote(draft).quote_type;
  return CREATE_QUOTES.filter((quote) => offered.includes(quote.quote_type) || quote.quote_type === current);
}

/** Coin selection comes first; either verified venue can support a pick. */
export function quoteUnavailableReason(state: Pick<CreateState, "quotes" | "draft" | "cetusTiers" | "bluefinOptions">, quoteType: string): string | null {
  if (!state.quotes.includes(quoteType)) return "Not available for new presales";
  if (venueAvailable(state, "cetus", quoteType) || venueAvailable(state, "bluefin", quoteType)) return null;
  return state.cetusTiers === null
    ? "Pool availability could not be checked. Try again shortly."
    : "No supported DEX is available for this coin. Try again shortly.";
}

/** Only SUI/USDC switches have an indexed conversion rate. */
export function quoteSwitchMessage(from: CreateQuote, to: CreateQuote): string {
  return [from.symbol, to.symbol].some((symbol) => symbol !== "SUI" && symbol !== "USDC")
    ? QUOTE_PICKER_COPY.unchanged
    : QUOTE_PICKER_COPY.converted;
}

/** Offer policy-approved coins supported by at least one verified DEX. */
export function availablePickerQuotes(state: Pick<CreateState, "quotes" | "draft" | "cetusTiers" | "bluefinOptions">): readonly CreateQuote[] {
  return pickerQuotes(state.quotes, state.draft).filter((quote) => quoteUnavailableReason(state, quote.quote_type) === null);
}

export function venueAvailable(state: Pick<CreateState, "quotes" | "draft" | "cetusTiers" | "bluefinOptions">, venue: CreateDraft["venue"], quoteType = state.draft.quote_type): boolean {
  if (!state.quotes.includes(quoteType)) return false;
  return venue === "cetus"
    ? cetusTiersForQuote(quoteType, state.cetusTiers).length > 0
    : venueTiers("bluefin").some(([spacing, fee]) => bluefinTierSupported(state.bluefinOptions, spacing, fee));
}

export function quoteDisplaySymbol(symbol: string): string {
  return symbol === "TEST_SUI" ? "TSUI" : symbol;
}
