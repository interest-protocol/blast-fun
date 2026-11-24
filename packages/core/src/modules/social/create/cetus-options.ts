import { CETUS_TIERS, createQuoteOf, type CreateDraft, type CreateIssue } from "@blast/core/modules/social/contracts/create.ts";

/** Live permissioned tiers by normalized quote type: [tick spacing, fee in millionths]. */
export type CreateCetusTiers = Readonly<Record<string, readonly (readonly [number, number])[]>>;

/** Keep the draft's fee-to-spacing mapping consistent with the transaction builder. */
export function cetusTiersForQuote(quote: string, supported: CreateCetusTiers | null | undefined) {
  return CETUS_TIERS.filter(([spacing, fee]) => supported?.[quote]?.some(([liveSpacing, liveFee]) => liveSpacing === spacing && liveFee === fee));
}

export function cetusDraftIssue(draft: CreateDraft, supported: CreateCetusTiers | null | undefined): CreateIssue | null {
  if (draft.venue !== "cetus") return null;
  const tiers = cetusTiersForQuote(draft.quote_type, supported);
  if (tiers.some(([, fee]) => fee === draft.pool_fee)) return null;
  const message = supported == null
    ? "Cetus availability could not be checked. Reload to try again or choose Bluefin."
    : tiers.length === 0
      ? `Cetus does not support ${createQuoteOf(draft.quote_type)?.symbol ?? "this raise coin"} for new presales. Choose another raise coin or Bluefin.`
      : "Cetus does not support this pool fee and tick spacing for the raise coin. Choose an available pool fee.";
  return { section: tiers.length === 0 ? "launch" : "raise", path: tiers.length === 0 ? "venue" : "pool_fee", message };
}
