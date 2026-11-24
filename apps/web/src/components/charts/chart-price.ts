import { exactDecimal } from "@blast/core/lib/exact-amount.ts";
import { numberDecimal, subscriptZeros } from "#web/lib/market-format.ts";

/** The longest label an axis, crosshair or readout draws. */
const LABEL = 12;
const SUFFIXES = [[12, "T"], [9, "B"], [6, "M"]] as const;

/**
 * Bounded canvas/readout labels in the site's one price format: plain digits
 * from 0.0001 to a million, four or more leading zeros counted in a subscript
 * as `readablePrice` writes them (`0.0₄812`), millions and up with a suffix
 * (`1.23M`). Only magnitudes from 10^15, which no price reaches, fall back to
 * a positive exponent. A readout can keep its zeros when they fit the label.
 */
export function chartPrice(value: string | null | undefined, precision = 6, preferPlain = false): string {
  const exact = exactDecimal(value);
  if (!exact) return "Unavailable";
  if (exact.n === 0n) return "0";
  const digits = exact.n.toString();
  const exponent = digits.length - exact.scale - 1;
  const kept = (budget: number) =>
    digits.slice(0, Math.max(1, Math.min(precision, budget))).replace(/0+$/, "");
  const pointed = (text: string, point: number) =>
    point >= text.length ? text.padEnd(point, "0") : `${text.slice(0, point)}.${text.slice(point)}`;
  if (exponent < 0) {
    const zeros = -exponent - 1;
    const plain = kept(LABEL);
    if (preferPlain && zeros + plain.length + 2 <= LABEL)
      return `0.${"0".repeat(zeros)}${plain}`;
    const budget = zeros >= 4 ? LABEL - 3 - String(zeros).length : LABEL - 2 - zeros;
    return subscriptZeros(`0.${"0".repeat(zeros)}${kept(budget)}`);
  }
  if (exponent < 6) return pointed(kept(LABEL - 1), exponent + 1);
  const suffix = SUFFIXES.find(([shift]) => exponent >= shift && exponent < shift + 3);
  if (suffix) return `${pointed(kept(LABEL - 2), exponent - suffix[0] + 1)}${suffix[1]}`;
  const mantissa = kept(LABEL - 2 - String(exponent).length);
  return `${mantissa[0]}${mantissa.length > 1 ? `.${mantissa.slice(1)}` : ""}e${exponent}`;
}

/** A plotted number (an axis tick, the crosshair) in `chartPrice`'s format, signed when below zero. */
export function chartNumber(value: number, precision = 6): string {
  if (!Number.isFinite(value)) return "";
  const label = chartPrice(numberDecimal(Math.abs(value)), precision);
  return value < 0 && label !== "0" ? `-${label}` : label;
}
