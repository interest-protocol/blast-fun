import { exactAtoms, exactDecimal, multiplyExact, type Exact } from "@blast/core/lib/exact-amount.ts";

const PRICE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** `price × supply ÷ 10^decimals` to two places, half up, on integers; null for anything malformed. */
export function fdvOf(priceUsd: string | null, supplyAtoms: string | null, decimals: number): string | null {
  if (priceUsd === null || supplyAtoms === null || !/^(0|[1-9][0-9]*)$/.test(supplyAtoms) || !Number.isInteger(decimals) || decimals < 0) return null;
  const match = PRICE.exec(priceUsd);
  if (!match) return null;
  const fraction = match[2] ?? "";
  // price = digits / 10^scale; value in cents = digits × supply × 100 / 10^(scale + decimals).
  const digits = BigInt(match[1]! + fraction);
  const scale = BigInt(fraction.length + decimals);
  const numerator = digits * BigInt(supplyAtoms) * 100n;
  const divisor = 10n ** scale;
  const cents = (2n * numerator + divisor) / (2n * divisor);
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** Pool prices are in quote atoms per token atom. Convert the total valuation to whole quote units. */
export function fdvInQuote(
  price: string | null | undefined,
  supply: bigint | string | null | undefined,
  quoteDecimals: bigint | string | null | undefined,
): Exact | null {
  if (quoteDecimals == null || !/^(0|[1-9][0-9]{0,2})$/.test(String(quoteDecimals))) return null;
  const decimals = Number(quoteDecimals);
  if (decimals > 255) return null;
  const total = exactAtoms(supply, decimals);
  const rate = exactDecimal(price);
  return total && rate ? multiplyExact(total, rate) : null;
}
