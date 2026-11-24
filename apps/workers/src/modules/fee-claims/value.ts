// What a claim is worth, in MIST, for the owner's rule: a claim is sent only
// when worth at least `BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE` times its
// simulated gas. Exact integer arithmetic, rounded down, and conservative: an
// amount with no price is worth nothing here (it still rides along in the
// same claim when the rest pays for it).
//
// - SUI is itself.
// - Another coin goes through USD: blast-infra's committed
//   `chain_read_v1.prices` (Pyth for configured quotes) and its decimals from
//   `chain_read_v1.coin_metadata`, against SUI's USD price.
// - A launch's Meme on a live curve is priced at the curve's spot price
//   (virtual plus real Quote over the Meme reserve), then as its Quote. After
//   migration it needs a price row of its own.

import { SUI_COIN_TYPE as SUI_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { autocommitRead } from "@blast/core/modules/database/transaction.ts";

export { SUI_COIN_TYPE as SUI_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/** A USD price per whole coin as an exact fraction, and the coin's decimals. */
export type CoinPrice = Readonly<{ numerator: bigint; scale: bigint; decimals: number }>;

const PRICES = `SELECT p.coin_type, p.usd_price::text AS usd_price, m.decimals
  FROM chain_read_v1.prices p
  JOIN chain_read_v1.coin_metadata m ON m.coin_type = p.coin_type
  WHERE p.coin_type = ANY($1::text[]) AND p.usd_price > 0 AND m.decimals IS NOT NULL
  ORDER BY p.coin_type, (p.source = 'pyth') DESC, p.as_of_ms DESC`;
assertChainReadThroughViews(PRICES);

/** `"12.3400"` as 123400 / 10^4; null for anything else. */
export function parseDecimal(text: string): Readonly<{ numerator: bigint; scale: bigint }> | null {
  const match = /^(\d{1,40})(?:\.(\d{1,40}))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { numerator: BigInt(`${match[1]}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

/** USD prices of `coinTypes` (normalized), from the primary's committed views; a coin without one is absent. */
export async function readPrices(pool: Pool, coinTypes: readonly string[]): Promise<Map<string, CoinPrice>> {
  const types = [...new Set(coinTypes.map((type) => normalizeStructTag(type)))];
  const { rows } = await autocommitRead<{ coin_type: string; usd_price: string; decimals: number }>(pool, "fee-claims", PRICES, [types]);
  const prices = new Map<string, CoinPrice>();
  for (const row of rows) {
    const type = normalizeStructTag(row.coin_type);
    const price = parseDecimal(row.usd_price);
    if (prices.has(type) || !price || price.numerator === 0n || row.decimals < 0 || row.decimals > 30) continue;
    prices.set(type, { ...price, decimals: row.decimals });
  }
  return prices;
}

/** `amount` atoms of a coin priced `price`, in MIST at SUI's `sui` price; rounded down. */
export function toMist(amount: bigint, price: CoinPrice, sui: CoinPrice): bigint {
  if (amount <= 0n) return 0n;
  // amount / 10^d × (n / s) USD ÷ (nS / sS) USD per SUI × 10^9 MIST per SUI.
  const numerator = amount * price.numerator * sui.scale * 1_000_000_000n;
  const denominator = 10n ** BigInt(price.decimals) * price.scale * sui.numerator;
  return numerator / denominator;
}

/** `amount` atoms of `coinType` in MIST; zero without a price for it or for SUI. */
export function coinValueMist(amount: bigint, coinType: string, prices: ReadonlyMap<string, CoinPrice>): bigint {
  if (amount <= 0n) return 0n;
  const type = normalizeStructTag(coinType);
  if (type === SUI_TYPE) return amount;
  const price = prices.get(type);
  const sui = prices.get(SUI_TYPE);
  return price && sui ? toMist(amount, price, sui) : 0n;
}

/** Meme atoms at a live curve's spot price, in Quote atoms; zero when the curve holds no Meme. */
export function curveMemeInQuote(meme: bigint, curve: Readonly<{ memeReserve: bigint; virtualQuote: bigint; realQuoteReserve: bigint }>): bigint {
  if (meme <= 0n || curve.memeReserve <= 0n) return 0n;
  return (meme * (curve.virtualQuote + curve.realQuoteReserve)) / curve.memeReserve;
}
