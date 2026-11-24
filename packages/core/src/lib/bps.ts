/**
 * Basis points, exactly: the slippage floor every trade path signs and the
 * percentage every bps figure reads as.
 */

import { exactText, fixedExact } from "./exact-amount.ts";

const ALL_BPS = 10_000n;
const ALL_BPS_NUMBER = 10_000;

/** Whether `bps` is a slippage tolerance a trade can carry: 0 up to, not including, 100%. */
export function isSlippageBps(bps: bigint): boolean {
  return bps >= 0n && bps < ALL_BPS;
}

/** The fewest atoms within the tolerance. Round the allowed loss down to a whole atom. */
export function minimumOut(expected: bigint, slippageBps: bigint): bigint {
  return expected - (expected * slippageBps) / ALL_BPS;
}

/** Basis points as an exact percentage: `5` → `0.05%`, `250` → `2.5%`, `10000` → `100%`. */
export function bpsPercent(bps: bigint | number): string {
  const value = BigInt(bps);
  const text = exactText({ n: value < 0n ? -value : value, scale: 2 });
  return `${value < 0n ? "-" : ""}${text}%`;
}

/** Basis points as a plain ratio for bars and rings: `7500` → `0.75`, `12500` → `1.25`. */
export function bpsRatio(bps: number): number {
  return bps / ALL_BPS_NUMBER;
}

/** Basis points as a multiple, two places half up: `12500` → `1.25×`, `10050` → `1.01×`. */
export function bpsMultiple(bps: number): string {
  return `${fixedExact({ n: BigInt(bps), scale: 4 }, 2)}×`;
}
