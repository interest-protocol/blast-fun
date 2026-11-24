/**
 * The site's one exact number: a non-negative decimal kept as an integer over
 * a power of ten, so a figure read from chain atoms and its coin's decimals
 * is added, divided, rounded, floored and compared without a float. Every
 * money format (the gate's `qty`, `bxUsd`, `bxPx`, `amtFmt`, `pxNum`,
 * `numShort`) is written here once; nothing here knows a coin.
 */

/** `n / 10^scale`, `n >= 0`. */
export type Exact = Readonly<{ n: bigint; scale: number }>;

export const ZERO_EXACT: Exact = Object.freeze({ n: 0n, scale: 0 });

const ATOMS = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Atoms of a coin with `decimals`, or null for anything but a non-negative integer and whole decimals. */
export function exactAtoms(atoms: bigint | string | null | undefined, decimals: number | null | undefined): Exact | null {
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return null;
  if (typeof atoms === "bigint") return atoms < 0n ? null : { n: atoms, scale: decimals };
  return typeof atoms === "string" && ATOMS.test(atoms) ? { n: BigInt(atoms), scale: decimals } : null;
}

/** A plain non-negative decimal (`12`, `0.000556`), or null. */
export function exactDecimal(text: string | null | undefined): Exact | null {
  const match = typeof text === "string" ? DECIMAL.exec(text) : null;
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { n: BigInt(match[1] + fraction), scale: fraction.length };
}

const pow10 = (k: number) => 10n ** BigInt(k);

/**
 * A finite non-negative number as the decimal it prints as, exactly (its
 * shortest round-trip digits, never its binary expansion): `1.63e-7` →
 * 0.000000163. Null for anything else.
 */
export function exactNumber(value: number): Exact | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const [mantissa = "0", power = "0"] = value.toExponential().split("e");
  const digits = BigInt(mantissa.replace(".", ""));
  const scale = mantissa.replace(/^\d\.?/, "").length - Number(power);
  return scale >= 0 ? { n: digits, scale } : { n: digits * pow10(-scale), scale: 0 };
}

/** `value` in units of `10^-scale`: exact when it gains places, else rounded half up or floored. */
export function unitsAt(value: Exact, scale: number, mode: "half-up" | "floor"): bigint {
  if (value.scale <= scale) return value.n * pow10(scale - value.scale);
  const divisor = pow10(value.scale - scale);
  const whole = value.n / divisor;
  return mode === "half-up" && (value.n % divisor) * 2n >= divisor ? whole + 1n : whole;
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. */
export function compareExact(a: Exact, b: Exact): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const left = unitsAt(a, scale, "floor");
  const right = unitsAt(b, scale, "floor");
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `a + b`, exactly. */
export function addExact(a: Exact, b: Exact): Exact {
  const scale = Math.max(a.scale, b.scale);
  return { n: unitsAt(a, scale, "floor") + unitsAt(b, scale, "floor"), scale };
}

/** `a - b`, exactly, or null when `b` is larger. */
export function subtractExact(a: Exact, b: Exact): Exact | null {
  const scale = Math.max(a.scale, b.scale);
  const n = unitsAt(a, scale, "floor") - unitsAt(b, scale, "floor");
  return n < 0n ? null : { n, scale };
}

/** `a × b`, exactly. */
export function multiplyExact(a: Exact, b: Exact): Exact {
  return { n: a.n * b.n, scale: a.scale + b.scale };
}

/**
 * `a ÷ b` rounded down to `places`, or null for a zero divisor. By default it
 * keeps eight places past the quotient's first possible digit, so every
 * format here rounds it exactly as it would round the true quotient (a floor
 * past the last place a format keeps never moves its rounding).
 */
export function divideExact(a: Exact, b: Exact, places?: number): Exact | null {
  if (b.n === 0n) return null;
  const scale = places ?? Math.max(0, b.n.toString().length + a.scale - b.scale) + 8;
  const shift = scale + b.scale - a.scale;
  const n = shift >= 0 ? (a.n * pow10(shift)) / b.n : a.n / (b.n * pow10(-shift));
  return { n, scale };
}

/** `value` divided by `10^k`, exactly. */
export function shiftExact(value: Exact, k: number): Exact {
  return { n: value.n, scale: value.scale + k };
}

/** Whether `value` is at least `10^k`. */
export function atLeastPow10(value: Exact, k: number): boolean {
  return compareExact(value, { n: pow10(Math.max(0, k)), scale: Math.max(0, -k) }) >= 0;
}

/** Whole digits grouped in complete thousands after a non-zero lead: `1,000`, `12,345,678`; never `0,500` or `12,50`. */
const THOUSANDS = /^[1-9]\d{0,2}(?:,\d{3})+$/;

/**
 * Reads a comma that is a decimal mark as a point, so a comma-decimal keypad's
 * `0,5` is half, never five. Commas are grouping only when a point follows them
 * (`1,000.5`) or they group whole thousands (`1,000`); a comma after the last
 * point is the decimal mark of a point-grouped number (`1.234,5`). Any other
 * last comma is the decimal mark (`0,5`, `1,5`, `12,50`), and the commas before
 * it are grouping. Other characters are left for the caller's own cleaning.
 */
export function decimalPoint(text: string): string {
  const comma = text.lastIndexOf(",");
  if (comma < 0) return text;
  const point = text.lastIndexOf(".");
  if (point > comma) return text.replaceAll(",", "");
  if (point >= 0) return `${text.slice(0, comma).replaceAll(".", "")}.${text.slice(comma + 1)}`;
  if (THOUSANDS.test(text.replace(/[^\d,]/g, ""))) return text.replaceAll(",", "");
  return `${text.slice(0, comma).replaceAll(",", "")}.${text.slice(comma + 1)}`;
}

/**
 * `value` with `inserted` (what was typed or pasted) in place of `value[start, end)`,
 * the inserted text read by `decimalPoint`. Only the inserted text is read: the
 * commas the field already showed stay grouping, so typing `5` after `1,000`
 * leaves `1,0005` for the field to regroup (`10,005`). A typed comma is the
 * decimal mark, or is dropped when the rest of the field already has a point.
 */
export function insertDecimal(value: string, start: number, end: number, inserted: string): string {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const read = (before + after).includes(".") ? inserted.replaceAll(",", "") : decimalPoint(inserted);
  return before + read + after;
}

/** en-US thousands grouping of a plain decimal's whole part: `1234567.891` → `1,234,567.891`. */
export function groupDigits(decimal: string): string {
  const [whole = "", fraction] = decimal.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Drops trailing fraction zeros and a bare point: `5.0` → `5`, `1.20` → `1.2`. */
function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** `value` exactly, trailing zeros dropped, never grouped: `412.38`, `0.000001`, `7`. */
export function exactText(value: Exact): string {
  return trimZeros(fixedExact(value, value.scale, "floor"));
}

/** `value` to `places` (rounded half up, or floored), as `digits[.digits]` with every place kept. */
export function fixedExact(value: Exact, places: number, mode: "half-up" | "floor" = "half-up"): string {
  const scaled = unitsAt(value, places, mode).toString();
  if (places === 0) return scaled;
  const padded = scaled.padStart(places + 1, "0");
  return `${padded.slice(0, -places)}.${padded.slice(-places)}`;
}

/**
 * `Number(value).toLocaleString("en-US", { maximumFractionDigits: places })`
 * done exactly: rounded half up to `places`, trailing zeros dropped, the whole
 * part grouped — `1,234.5`, `25`, `0.06`.
 */
export function groupedExact(value: Exact, places: number, mode: "half-up" | "floor" = "half-up"): string {
  return groupDigits(trimZeros(fixedExact(value, places, mode)));
}

/**
 * The gate's `numShort`, exact: `1.84B` from a billion and `1.25M` from a
 * million (two places, as the boards write them), `12.5K` from a thousand (one
 * place, none from 100K), else whole and grouped. Rounds half up, as `toFixed`
 * means to.
 */
export function numShortExact(value: Exact): string {
  if (atLeastPow10(value, 9) || carriesUp(value, 6, 2)) return `${trimZeros(fixedExact(shiftExact(value, 9), 2))}B`;
  if (atLeastPow10(value, 6) || carriesUp(value, 3, 0)) return `${trimZeros(fixedExact(shiftExact(value, 6), 2))}M`;
  if (atLeastPow10(value, 3)) return `${trimZeros(fixedExact(shiftExact(value, 3), atLeastPow10(value, 5) ? 0 : 1))}K`;
  return groupedExact(value, 0);
}

/**
 * A coin amount for a narrow tile, exact: `1.3M`, `18K`, `5.4K`, `412`,
 * `41.3`. A carry moves up a unit: `999,999` reads `1M`, `999.6` reads `1K`.
 */
export function shortQtyExact(value: Exact): string {
  if (atLeastPow10(value, 6) || carriesUp(value, 3, 0)) return `${trimZeros(fixedExact(shiftExact(value, 6), 1))}M`;
  if (atLeastPow10(value, 4)) return `${fixedExact(shiftExact(value, 3), 0)}K`;
  if (atLeastPow10(value, 3) || carriesUp(value, 0, 0)) return `${trimZeros(fixedExact(shiftExact(value, 3), 1))}K`;
  if (atLeastPow10(value, 2)) return fixedExact(value, 0);
  return trimZeros(fixedExact(value, 1));
}

/** Whether `value` in units of `10^power`, rounded half up to `places`, reaches 1,000 of them (the next unit up). */
function carriesUp(value: Exact, power: number, places: number): boolean {
  return unitsAt(shiftExact(value, power), places, "half-up") >= 1000n * pow10(places);
}

/**
 * The gate's `shortFloor`, exact: the same figure **rounded down**, so a raise
 * never reads as its target before it gets there — `399K`, `1.24M`, `9.9K`,
 * `1.99B`.
 */
export function shortFloorExact(value: Exact): string {
  if (atLeastPow10(value, 9)) return `${trimZeros(fixedExact(shiftExact(value, 9), 2, "floor"))}B`;
  if (atLeastPow10(value, 6)) return `${trimZeros(fixedExact(shiftExact(value, 6), 2, "floor"))}M`;
  if (atLeastPow10(value, 5)) return `${fixedExact(shiftExact(value, 3), 0, "floor")}K`;
  if (atLeastPow10(value, 3)) return `${trimZeros(fixedExact(shiftExact(value, 3), 1, "floor"))}K`;
  return groupedExact(value, 0, "floor");
}

/** The number of digits before the point of a positive `value` below one, counted as leading zeros after it. */
function leadingZeros(value: Exact): number {
  const digits = value.n.toString();
  return value.scale - digits.length;
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/**
 * The site's one way to write a tiny decimal: four or more zeros after the
 * point become one zero and a subscript count, as the boards write prices:
 * `0.0000812` → `0.0₄812`, `0.00000000182` → `0.0₈182`. Any other text is
 * returned unchanged. Display only; callers keep the exact decimal for
 * inspection and calculation.
 */
export function subscriptZeros(decimal: string): string {
  return decimal.replace(
    /^0\.(0{4,})([1-9]\d*)$/,
    (_, leading: string, digits: string) =>
      `0.0${String(leading.length)
        .split("")
        .map((digit) => SUBSCRIPT[Number(digit)])
        .join("")}${digits}`,
  );
}

/**
 * The gate's `pxNum`, exact: two places from 1, four from 0.01, else three
 * significant digits (`0.000556`), with four or more leading zeros written as
 * a subscript like every price on the site (`0.0₆163`), never in exponent form.
 */
export function pxNumExact(value: Exact): string {
  if (atLeastPow10(value, 0)) return fixedExact(value, 2);
  if (atLeastPow10(value, -2)) return fixedExact(value, 4);
  if (value.n === 0n) return "0";
  // Three significant digits: the places down to the third digit after the leading zeros.
  // A carry (0.0009995 → 0.001) is counted after rounding, so it never keeps a stale zero.
  return subscriptZeros(trimZeros(fixedExact(value, leadingZeros(value) + 3)));
}

/**
 * The gate's `qty`: `2.31M`, `1.2B`, whole and grouped from 10,000
 * (`47,619`), else at most two places (`4,239.83`, `0.5`). Rounds half up.
 */
export function qtyExact(value: Exact): string {
  // 999,999,999 rounds to 1,000.00M; it reads 1B.
  if (atLeastPow10(value, 9) || carriesUp(value, 6, 2)) return `${groupedExact(shiftExact(value, 9), 2)}B`;
  if (atLeastPow10(value, 6)) return `${groupedExact(shiftExact(value, 6), 2)}M`;
  if (atLeastPow10(value, 4)) return groupedExact(value, 0);
  return groupedExact(value, 2);
}

/**
 * The gate's `bxUsd`: whole dollars from $100 up, cents below, and never
 * `.00` on a round amount: `$860`, `$1,260`, `$99.85`, `$50`.
 */
export function bxUsdExact(value: Exact): string {
  const cents = unitsAt(value, 2, "half-up");
  if (!atLeastPow10(value, 2) && cents % 100n !== 0n) return `$${fixedExact(value, 2)}`;
  return `$${groupedExact(value, 0)}`;
}

/**
 * The gate's `bxPx`: a ticking price keeps four significant digits, trailing
 * zeros included, so it never changes width (`$0.002100`); two places from
 * $1 (`$3.42`, `$1,410.35`); four or more leading zeros as a subscript
 * (`$0.0₆1630`).
 */
export function bxPxExact(value: Exact): string {
  if (atLeastPow10(value, 0)) return `$${groupDigits(fixedExact(value, 2))}`;
  if (value.n === 0n) return "$0.000";
  return `$${subscriptZeros(fixedExact(value, significantPlaces(value, 4)))}`;
}

/**
 * The gate's `amtFmt` (a traded amount, a fee): whole and grouped from
 * 10,000, rounded down; from 1 at most two places, rounded down; below 1
 * three significant digits; `0` for nothing: `47,619`, `341.99`, `0.292`.
 */
export function amtExact(value: Exact): string {
  if (atLeastPow10(value, 4)) return groupedExact(value, 0, "floor");
  if (atLeastPow10(value, 0)) return groupedExact(value, 2, "floor");
  if (value.n === 0n) return "0";
  return trimZeros(fixedExact(value, significantPlaces(value, 3)));
}

/**
 * The places that keep `digits` significant digits of a positive `value`
 * below one, one fewer when rounding carries into a new leading digit
 * (0.0099996 → 0.01000, not 0.010000).
 */
function significantPlaces(value: Exact, digits: number): number {
  const leading = leadingZeros(value);
  const places = leading + digits;
  return unitsAt(value, places, "half-up") >= pow10(digits) ? places - 1 : places;
}
