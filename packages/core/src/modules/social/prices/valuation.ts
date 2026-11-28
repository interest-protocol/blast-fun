import { exactAtoms, exactDecimal, exactText, multiplyExact, type Exact } from "@blast/core/lib/exact-amount.ts";

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

/**
 * The coins in circulation: minted, less the burns still pending and the coins held at 0x0. It is
 * blast-infra's live supply, the one Home's market cap uses. Null when none circulate.
 */
export function liveSupplyAtoms(inputs: Readonly<{ currencySupply: bigint; pendingBurnTotal: bigint; balance0x0: bigint }> | null | undefined): bigint | null {
  if (!inputs) return null;
  const live = inputs.currencySupply - inputs.pendingBurnTotal - inputs.balance0x0;
  return live > 0n ? live : null;
}

/**
 * USD per quote coin times the whole coins in circulation. A whole-token price in the quote, times
 * this, is the market cap in USD; the coin page's headline and chart axis both multiply by it, so they agree.
 */
export function marketCapRate(quoteUsd: string | null | undefined, supplyAtoms: bigint | string | null | undefined, decimals: number | null | undefined): string | null {
  const rate = exactDecimal(quoteUsd);
  const supply = exactAtoms(supplyAtoms, decimals);
  return rate?.n && supply?.n ? exactText(multiplyExact(rate, supply)) : null;
}
