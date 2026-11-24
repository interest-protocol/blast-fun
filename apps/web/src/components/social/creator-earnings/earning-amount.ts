import {
  atLeastPow10,
  compareExact,
  exactDecimal,
  groupedExact,
} from "@blast/core/web/exact-amount.ts";

/** Display only: retain exact decimal arithmetic and never hide a positive balance as zero. */
export function earningAmount(amount: string, estimated = false, exact = false): string {
  const value = exactDecimal(amount);
  if (value === null) return "Unavailable";
  if (exact) return `${estimated && value.n > 0n ? "≈" : ""}${groupedExact(value, value.scale)}`;
  if (value.n > 0n && !atLeastPow10(value, -6)) return "<0.000001";

  const shown = groupedExact(value, atLeastPow10(value, 0) ? 2 : 6);
  const rounded = compareExact(value, exactDecimal(shown.replaceAll(",", ""))!) !== 0;
  return `${value.n > 0n && (estimated || rounded) ? "≈" : ""}${shown}`;
}
