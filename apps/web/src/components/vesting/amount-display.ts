import { groupedExact } from "@blast/core/lib/exact-amount.ts";

/** Display only; transaction amounts and editable inputs retain their exact atoms. */
export function displayVestingAmount(
  value: bigint | string,
  decimals: number | null,
): string {
  const atoms = BigInt(value);
  if (decimals === null) {
    return `${groupedExact({ n: atoms, scale: 0 }, 0)} atoms`;
  }
  const amount = groupedExact({ n: atoms, scale: decimals }, 2, "floor");
  return atoms > 0n && amount === "0" ? "<0.01" : amount;
}
