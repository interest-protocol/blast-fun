import { assertPrice, type Price } from "#workers/modules/reward-plan/prices.ts";

export const DAY_MS = 86_400_000n;
export const MAX_POSITIVE_LEAVES = 65_536n;

export function qualifies(weight: bigint, tokenUsd: Price): boolean {
  assertPrice(tokenUsd);
  if (weight < 0n) throw new Error("Invalid holder weight.");
  return weight * tokenUsd.numerator >= 5n * DAY_MS * tokenUsd.denominator;
}

/** The smallest weight that `qualifies` at this price: dust below it never earns a leaf. */
export function minimumWeight(tokenUsd: Price): bigint {
  assertPrice(tokenUsd);
  const floor = 5n * DAY_MS * tokenUsd.denominator;
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
