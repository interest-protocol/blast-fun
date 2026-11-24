import { chartPrice } from "./chart-price";
import { exactDecimal } from "@blast/core/lib/exact-amount.ts";

/** Only integer ratios become canvas coordinates; original values remain exact in feature readouts. */
export function exactChartScale(values: readonly string[]) {
  const parsed = values
    .map((value) => exactDecimal(value))
    .filter((value) => value !== null);
  const scale = Math.max(0, ...parsed.map((value) => value.scale)) + 4;
  const integers = parsed.map(
    (value) => value.n * 10n ** BigInt(scale - value.scale),
  );
  let low = integers.reduce((a, b) => (a < b ? a : b), integers[0] ?? 0n);
  let high = integers.reduce((a, b) => (a > b ? a : b), integers[0] ?? 0n);
  const flat = low === high;
  if (flat) {
    const pad = high / 20n || 1n;
    low = high > pad ? high - pad : 0n;
    high += pad;
  }
  const span = high - low;
  const coordinate = (value: string) => {
    const exact = exactDecimal(value);
    if (!exact) return 0;
    const integer = exact.n * 10n ** BigInt(scale - exact.scale);
    return Number(((integer - low) * 100_000_000n) / span) / 1_000_000;
  };
  /** A coordinate's price label; `significant` caps its digits (a volume axis), else enough to tell ticks apart. */
  const format = (value: number, significant?: number, round = false) => {
    const integer =
      low + (span * BigInt(Math.round(value * 1_000_000))) / 100_000_000n;
    const precision = significant ?? Math.max(6, high.toString().length - span.toString().length + 3);
    const positive = integer < 0n ? 0n : integer;
    const unit = round ? 10n ** BigInt(Math.max(0, positive.toString().length - precision)) : 1n;
    const rounded = ((positive + unit / 2n) / unit) * unit;
    const digits = rounded.toString().padStart(scale + 1, "0");
    const exact = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
      .replace(/0+$/, "")
      .replace(/\.$/, "");
    return chartPrice(exact, precision);
  };
  return { coordinate, format, flat };
}
