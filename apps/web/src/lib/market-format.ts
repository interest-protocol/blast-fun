import {
  amtExact,
  atLeastPow10,
  exactAtoms,
  exactDecimal,
  fixedExact,
  groupedExact,
  groupDigits,
  numShortExact,
  qtyExact,
  subscriptZeros,
} from "@blast/core/lib/exact-amount.ts";

/** The site's subscript-zero rule (`0.0000812` → `0.0₄812`), shared with the coin-quoted prices in core. */
export { subscriptZeros };

/**
 * A short figure for a tight row (`1.24M`, `47,619`, `4,239.83`, `0.000556`)
 * that never reads a nonzero amount as zero. Null when the atoms or decimals are unknown.
 */
export function compactFigure(atoms: string | null | undefined, decimals: number | null): string | null {
  const amount = exactAtoms(atoms, decimals);
  if (amount === null) return null;
  return atLeastPow10(amount, 0) ? qtyExact(amount) : amtExact(amount);
}

/** A JavaScript number as a plain decimal, never in exponent form: `1.2e-7` → `0.00000012`. */
export function numberDecimal(value: number): string {
  const [mantissa = "0", power = "0"] = value.toExponential().split("e");
  const digits = mantissa.replace(".", "").replace("-", "");
  const point = Number(power) + 1;
  const sign = value < 0 ? "-" : "";
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  return `${sign}${point >= digits.length ? digits.padEnd(point, "0") : `${digits.slice(0, point)}.${digits.slice(point)}`}`;
}

/** Display precision only. Inspection and every calculation retain the original decimal. */
export function readablePrice(raw: string): string {
  const value = exactDecimal(raw);
  if (!value) return "—";
  if (value.n === 0n) return "0";
  if (atLeastPow10(value, 0)) return groupedExact(value, 2);
  const zeros = Math.max(0, value.scale - value.n.toString().length);
  const rounded = fixedExact(value, Math.max(4, zeros + 3))
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return subscriptZeros(rounded);
}

/** Fixed precision in each Home table price range, including after rounding up into a new range. */
export function homeTablePrice(raw: string): string {
  const value = exactDecimal(raw);
  if (!value) return "—";
  const places = (quote: typeof value) => quote.n === 0n || atLeastPow10(quote, 0)
    ? 2 : Math.max(4, quote.scale - quote.n.toString().length + 3);
  const rounded = exactDecimal(fixedExact(value, places(value)))!;
  return "$" + subscriptZeros(groupDigits(fixedExact(rounded, places(rounded))));
}

/** Compact from $1,000 (`$1.2K`, `$48.2M`, `$1.84B`), cents from $1, and meaningful nonzero values below one dollar. */
export function readableUsd(raw: string): string {
  const value = exactDecimal(raw);
  if (!value) return "—";
  return `$${atLeastPow10(value, 3) ? numShortExact(value) : atLeastPow10(value, 0) ? groupedExact(value, 2) : readablePrice(raw)}`;
}
