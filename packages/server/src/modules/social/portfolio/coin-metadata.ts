import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

export type CoinMetadata = Readonly<{
  coin_type: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  icon_url: string | null;
  is_presale: boolean;
}>;

export const COIN_METADATA_SQL = `
  SELECT m.coin_type, m.name, m.symbol, m.decimals::int, m.icon_url,
    EXISTS (SELECT 1 FROM chain_read_v1.presales p WHERE p.sale_token = m.coin_type) AS is_presale
  FROM chain_read_v1.coin_metadata m WHERE m.coin_type = ANY($1::text[])`;

/** Indexed metadata only; missing decimals never become an assumed token amount. */
export async function readCoinMetadata(db: ReadableDatabase, coinTypes: readonly string[]): Promise<Map<string, CoinMetadata>> {
  if (coinTypes.length === 0) return new Map();
  const { rows } = await db.read<CoinMetadata>(COIN_METADATA_SQL, [coinTypes]);
  return new Map(rows.map((row) => [row.coin_type, {
    ...row,
    decimals: Number.isInteger(row.decimals) && row.decimals! >= 0 && row.decimals! <= 255 ? row.decimals : null,
  }]));
}
