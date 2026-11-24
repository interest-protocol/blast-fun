export const AMOUNT_STEPS = ["short", "medium", "long"] as const;

/** How long the amount reads, so its type can step down (16, 14, 12px) instead of running under the chips. */
export function amountLength(value: string): (typeof AMOUNT_STEPS)[number] {
  return value.length <= 9 ? "short" : value.length <= 13 ? "medium" : "long";
}
