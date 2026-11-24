/**
 * A price's move as basis points, from two decimal strings as PostgreSQL
 * renders `numeric` (`digits[.digits]`), computed on integers so the answer
 * is exact: `round((now / then − 1) × 10000)`, half away from zero (R3-20's
 * `change_24h_bps`). Null when either price is missing, negative or
 * malformed, or the older one is zero — never a made-up 0.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function parse(value: string): Readonly<{ digits: bigint; scale: number }> | null {
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { digits: BigInt(match[1] + fraction), scale: fraction.length };
}

export function changeBps(now: string | null, then: string | null): number | null {
  if (now === null || then === null) return null;
  const a = parse(now);
  const b = parse(then);
  if (a === null || b === null || b.digits === 0n) return null;
  // now / then = (a.digits / 10^a.scale) / (b.digits / 10^b.scale) = top / bottom.
  const top = a.digits * 10n ** BigInt(b.scale);
  const bottom = b.digits * 10n ** BigInt(a.scale);
  const delta = (top - bottom) * 10_000n;
  const magnitude = delta < 0n ? -delta : delta;
  // Half away from zero: floor((2|x| + d) / 2d).
  const rounded = (2n * magnitude + bottom) / (2n * bottom);
  return Number(delta < 0n ? -rounded : rounded);
}

/** Basis points as the percentage the cards show (`−182` → `−1.82`). */
export function bpsToPct(bps: number | null): number | null {
  return bps === null ? null : bps / 100;
}
