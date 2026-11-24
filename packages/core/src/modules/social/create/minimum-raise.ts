import { compareExact, divideExact, exactDecimal, exactText, multiplyExact } from "@blast/core/lib/exact-amount.ts";
import { fieldNumber } from "@blast/core/lib/format.ts";
import { CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_QUOTE_TYPE, createQuoteOf, type CreateDraft, type CreateIssue } from "@blast/core/modules/social/contracts/create.ts";

export function presaleTargetDecimals(quoteType: string): number {
  return quoteType === CREATE_HASHI_BTC_QUOTE_TYPE ? 4 : 2;
}

/** Round up at the precision the draft and the final transaction both accept. */
export function minimumPresaleTarget(quoteType: string, quoteUsd: string | null): number | null {
  const price = exactDecimal(quoteType === CREATE_QUOTE_TYPE ? "1" : quoteUsd);
  if (!price?.n) return null;
  const usd = { n: 1_000n, scale: 0 };
  const down = divideExact(usd, price, presaleTargetDecimals(quoteType))!;
  const n = compareExact(multiplyExact(down, price), usd) < 0 ? down.n + 1n : down.n;
  const target = Number(exactText({ n, scale: down.scale }));
  return Number.isFinite(target) ? target : null;
}

export function minimumRaiseIssue(draft: Pick<CreateDraft, "target" | "quote_type">, quoteUsd: string | null): CreateIssue | null {
  const minimum = minimumPresaleTarget(draft.quote_type, quoteUsd);
  if (minimum === null) {
    return { section: "raise", path: "target", message: "Wait for a price or choose another raise coin." };
  }
  if (draft.target >= minimum) return null;

  const symbol = createQuoteOf(draft.quote_type)?.symbol;
  const amount = fieldNumber(minimum, presaleTargetDecimals(draft.quote_type));
  return { section: "raise", path: "target", message: `Set a target of at least ${amount}\u00a0${symbol === "TEST_SUI" ? "TSUI" : symbol}.` };
}
