const RESERVED_COIN_IDENTITIES = new Set([
  "blast",
  "sui",
  "walrus",
  "wal",
  "usdc",
  "usdcoin",
  "usdt",
  "tether",
  "usdsui",
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "solana",
  "sol",
]);

export function isReservedCoinIdentity(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").toLowerCase();
  return RESERVED_COIN_IDENTITIES.has(normalized);
}
