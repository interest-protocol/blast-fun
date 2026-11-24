// Display strings for exact atomic amounts. Integer string arithmetic only:
// nothing here rounds through floating point.

import { groupDigits } from "@blast/core/web/exact-amount.ts";

/**
 * A canonical decimal price cut to `digits` significant digits, toward zero,
 * with an ellipsis when digits were cut; e.g. `0.000004347826086…`.
 */
export function significantPrice(price: string, digits = 10): string {
  const [whole, fraction = ""] = price.split(".");
  if (whole !== "0") {
    const kept = fraction.slice(0, Math.max(0, digits - whole!.length));
    const cut = kept.length < fraction.length;
    return `${groupDigits(whole!)}${kept ? `.${kept}` : ""}${cut ? "…" : ""}`;
  }
  const leading = fraction.match(/^0*/)?.[0]?.length ?? 0;
  const kept = fraction.slice(0, leading + digits);
  return `0.${kept}${kept.length < fraction.length ? "…" : ""}`;
}
