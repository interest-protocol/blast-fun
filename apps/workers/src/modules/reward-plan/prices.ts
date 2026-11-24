import { requiredInteger } from "#workers/modules/worker-runtime/config.ts";

/** USD per atomic unit, from a validated financial observation. */
export type Price = Readonly<{ numerator: bigint; denominator: bigint }>;

/** How old and how uncertain a USD observation may be, for planning and for gas alike. */
export type PricePolicy = Readonly<{ maxAgeMs: number; maxConfidenceBps: number }>;

export function assertPrice(value: Price): void {
  if (value.numerator <= 0n || value.denominator <= 0n)
    throw new Error("Financial price is unavailable.");
}

export function pricePolicyFromEnvironment(environment: Readonly<Record<string, string | undefined>>): PricePolicy {
  return { maxAgeMs: requiredInteger(environment, "REWARDS_PRICE_MAX_AGE_MS", 0, 86400000), maxConfidenceBps: requiredInteger(environment, "REWARDS_PRICE_MAX_CONFIDENCE_BPS", 0, 10000) };
}
