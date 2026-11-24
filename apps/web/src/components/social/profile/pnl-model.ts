import { atLeastPow10, exactDecimal, fixedExact, groupDigits, groupedExact, numShortExact } from "@blast/core/web/exact-amount.ts";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import type { PnlFigures } from "@blast/core/web/contracts/pnl.ts";

export function canCreatePnlCard(figures: PnlFigures): boolean {
  return [figures.realized_usd, figures.unrealized_usd, figures.total_usd].every((value) => value !== null && pnlFigure(value).text !== "Unavailable");
}

/** Keep signed cents exact, including amounts beyond Number's safe range. */
export function pnlFigure(value: string | null, hidden = false, compact = false): Readonly<{ text: string; tone: "up" | "down" | null }> {
  if (hidden) return { text: HIDDEN_AMOUNT, tone: null };
  if (value === null) return { text: "Unavailable", tone: null };
  const amount = exactDecimal(value.replace(/^-/, ""));
  if (!amount) return { text: "Unavailable", tone: null };
  const negative = value.startsWith("-");
  const sign = amount.n === 0n ? "" : negative ? "−" : "+";
  const dollars = compact
    ? atLeastPow10(amount, 0) ? numShortExact(amount) : groupedExact(amount, 2)
    : groupDigits(fixedExact(amount, 2));
  return { text: `${sign}$${dollars}`, tone: amount.n === 0n ? null : negative ? "down" : "up" };
}
