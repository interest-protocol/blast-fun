import { assertPrice, type Price } from "#workers/modules/reward-plan/prices.ts";
import type { Frozen } from "#workers/modules/reward-plan/plan.ts";

export const DAY_MS = 86_400_000n;
export const MAX_POSITIVE_LEAVES = 65_536n;

/** Compare the USD value of the holder budget without rounding either asset. */
export function meetsPayoutMinimum(
  quote: bigint,
  quotePrice: Frozen["quotePrice"],
  minimumUsd: number,
  meme = 0n,
  memePrice: Frozen["memePrice"] = null,
): boolean {
  if (quote <= 0n || quotePrice === null) return false;
  const quoteNumerator = quote * BigInt(quotePrice.numerator);
  const quoteDenominator = BigInt(quotePrice.denominator);
  const minimum = BigInt(minimumUsd);
  if (memePrice === null) return quoteNumerator >= minimum * quoteDenominator;
  const memeNumerator = meme * BigInt(memePrice.numerator);
  const memeDenominator = BigInt(memePrice.denominator);
  return quoteNumerator * memeDenominator + memeNumerator * quoteDenominator >=
    minimum * quoteDenominator * memeDenominator;
}

/** Convert the USD holding minimum to the smallest eligible daily weight. */
export function minimumWeight(tokenUsd: Price, minimumUsd: number): bigint {
  assertPrice(tokenUsd);
  const floor = BigInt(minimumUsd) * DAY_MS * tokenUsd.denominator;
  return (floor + tokenUsd.numerator - 1n) / tokenUsd.numerator;
}

/**
 * The contracts' cap on a round's gas reserve: at most 10% of its holder Quote, the allocated
 * `quote_amount` (`EGasReserveTooLarge`).
 */
export function gasReserveFits(reserve: bigint, holderQuote: bigint): boolean {
  if (reserve < 0n || holderQuote < 0n) throw new Error("Invalid gas reserve.");
  return reserve * 10_000n <= holderQuote * 1_000n;
}
