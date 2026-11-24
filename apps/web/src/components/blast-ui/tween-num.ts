/**
 * Number formatting for the figures the gate counted (`tweenNum`, OA-30). Money figures and counts now update in
 * place, instantly (owner, 2026-10-28); `use-tween-num.tsx` draws them, and the spots are recorded in
 * `number-spots.test.ts`.
 */

import { atomsValue, qm, type SaleQuote } from "@blast/core/lib/format.ts";

/** The durations callers still name from the gate's `tweenNum`; figures no longer count, so nothing reads them. */
export const TWEEN_NUM_S = Object.freeze({
  default: 0.7,
  live: 0.6,
  lastHour: 0.8,
});

/** A count of people, as the gate formats it (`Math.round(v).toLocaleString('en-US')`). */
export function wholeCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * A coin-quoted figure (R3-40 with OA-28 M3): its whole coins, its quote, and
 * its exact atoms. Null without readable atoms.
 */
export type CoinCount = Readonly<{ value: number; quote: SaleQuote; atoms: string }>;

export function coinCount(quote: SaleQuote, atoms: string | null | undefined): CoinCount | null {
  const value = atomsValue(atoms, quote.decimals);
  return value !== null && atoms && Number.isFinite(value) ? { value, quote, atoms } : null;
}

/**
 * A coin figure as the gate's `qm` writes it: the read's own atoms for its
 * value, so it never shows a rounded float.
 */
export function coinCountText(count: CoinCount, shown: number): string {
  const atoms = shown === count.value ? count.atoms : String(Math.max(0, Math.round(shown * 10 ** count.quote.decimals)));
  return qm(count.quote, { usd: null, atoms }) ?? "—";
}
