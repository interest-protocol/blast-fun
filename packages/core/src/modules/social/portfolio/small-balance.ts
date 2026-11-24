import { coinPriority, coreCoin, PREFERRED_COINS } from "./core-coins.ts";

/** Exact per-token cutoff; preferred coins, positive core holdings and unknown decimals remain visible. */
export function isSmallBalance(atoms: string | bigint, decimals: number | null, coinType?: string): boolean {
  if (coinType && (coinPriority(coinType) < PREFERRED_COINS.length || (BigInt(atoms) > 0n && coreCoin(coinType)))) return false;
  return decimals !== null && BigInt(atoms) < 10n ** BigInt(decimals);
}
