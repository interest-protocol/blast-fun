// Display strings for the coin page. Exact decimal-string and bigint
// arithmetic only; values are truncated toward zero, never rounded up.

import { significantPrice } from "../format.ts";
import { groupDigits } from "@blast/core/web/exact-amount.ts";
import { NO_VALUE, atomsText } from "@blast/core/web/format.ts";

/** A non-negative canonical decimal string times 10^places, exactly. */
export function shiftDecimal(value: string, places: number): string {
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole!.length + places;
  const padded = point > digits.length ? digits.padEnd(point, "0") : point < 0 ? digits.padStart(digits.length - point, "0") : digits;
  const at = Math.max(point, 0);
  const integer = padded.slice(0, at).replace(/^0+(?=\d)/, "") || "0";
  const rest = padded.slice(at).replace(/0+$/, "");
  return rest ? `${integer}.${rest}` : integer;
}

/**
 * blast-infra's canonical price (Quote atoms per Meme atom) as Quote per
 * whole Meme token, cut to `digits` significant digits.
 */
export function formatPricePerToken(price: string, memeDecimals: number, quoteDecimals: number, digits = 7): string {
  return significantPrice(shiftDecimal(price, memeDecimals - quoteDecimals), digits);
}

/** Atomic `value` in whole units: two fractional digits, or four significant ones below 1. */
export function formatAmountShort(value: bigint, decimals: number): string {
  const [whole, fraction = ""] = atomsText(value, decimals).split(".");
  if (whole !== "0" || !fraction) {
    const kept = fraction.slice(0, 2).replace(/0+$/, "");
    return kept ? `${groupDigits(whole!)}.${kept}` : groupDigits(whole!);
  }
  const leading = fraction.match(/^0*/)?.[0]?.length ?? 0;
  return `0.${fraction.slice(0, leading + 4).replace(/0+$/, "")}`;
}

/** A USD decimal string with two fractional digits, or its significant ones below a cent. */
export function formatUsd(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  if (whole === "0" && /^00/.test(fraction)) return `$${significantPrice(value, 2)}`;
  const kept = fraction.slice(0, 2).replace(/0+$/, "");
  return `$${groupDigits(whole!)}${kept ? `.${kept}` : ""}`;
}

/** Unix ms as absolute UTC, the same on the server and in the browser. */
export function formatTime(ms: number | bigint): string {
  const iso = new Date(Number(ms)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** A length of time in hours, minutes and seconds. */
export function formatDuration(ms: bigint): string {
  const seconds = ms / 1000n;
  const parts: string[] = [];
  const hours = seconds / 3600n;
  const minutes = (seconds % 3600n) / 60n;
  const rest = seconds % 60n;
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest || parts.length === 0) parts.push(`${rest} s`);
  return parts.join(" ");
}

/** Atomic `atoms` of a coin with `decimals` as whole units and its symbol; a missing scale leaves the amount unknown. */
export function formatQuantity(atoms: bigint, decimals: number | bigint | null, symbol: string): string {
  return decimals === null ? NO_VALUE : `${formatAmountShort(atoms, Number(decimals))} ${symbol}`;
}
