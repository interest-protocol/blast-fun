// Trade amounts cross the display edge here and nowhere else: text becomes an
// exact atomic `bigint`, and atomic values become exact text. No floating
// point touches an amount.

const U64_MAX = (1n << 64n) - 1n;

export type AmountRefusal = "empty" | "negative" | "zero" | "malformed" | "grouping" | "precision" | "overflow";

export const AMOUNT_REFUSALS: Readonly<Record<AmountRefusal, string>> = {
  empty: "Enter an amount.",
  negative: "Enter an amount above zero; amounts cannot be negative.",
  zero: "Enter an amount above zero.",
  malformed: "Enter a plain number, such as 12.5.",
  grouping: "Use a point for decimals, such as 0.5. Commas may only separate thousands, such as 1,000.5.",
  precision: "That amount has more decimal places than this asset allows.",
  overflow: "That amount is larger than Sui can carry.",
};

/** The entry a success leaves: the same trade with an empty amount, so a finished amount is never typed into (#1012). */
export function freshTrade<Input extends Readonly<{ amount: string }>>(input: Input): Input {
  return { ...input, amount: "" };
}

export type ParsedAmount = Readonly<{ ok: true; atomic: bigint }> | Readonly<{ ok: false; reason: AmountRefusal }>;

/** Whole digits with commas only as complete thousands groups after a non-zero leading group: `1,000` or `12,345,678`, never `0,500`. */
const GROUPED = /^[1-9]\d{0,2}(,\d{3})+$/;

/**
 * Parses a plain decimal amount into atomic units of `10^-decimals`, refusing
 * anything a transaction could not carry exactly as a positive `u64`. A comma
 * is accepted only as a thousands separator in the whole part (`1,000.5`);
 * any other comma is refused, never dropped, since in many locales it is the
 * decimal mark (`0,5`).
 */
export function parseTradeAmount(text: string, decimals: number): ParsedAmount {
  let trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.includes(",")) {
    const [whole = "", ...rest] = trimmed.split(".");
    if (rest.some((part) => part.includes(",")) || !GROUPED.test(whole)) return { ok: false, reason: "grouping" };
    trimmed = [whole.replaceAll(",", ""), ...rest].join(".");
  }
  if (trimmed.startsWith("-")) return { ok: false, reason: "negative" };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed) ?? /^()\.(\d+)$/.exec(trimmed);
  if (!match) return { ok: false, reason: "malformed" };
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return { ok: false, reason: "precision" };
  const atomic = BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (atomic === 0n) return { ok: false, reason: "zero" };
  if (atomic > U64_MAX) return { ok: false, reason: "overflow" };
  return { ok: true, atomic };
}

/** Parses text `atomsGrouped` wrote back to atomic units; null when it is not such text. */
export function parseFormattedAtomic(text: string, decimals: number): bigint | null {
  const result = parseTradeAmount(text, decimals);
  if (result.ok) return result.atomic;
  return result.reason === "zero" ? 0n : null;
}
