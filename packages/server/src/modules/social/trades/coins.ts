import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { CORE_COINS, coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { readCoinMetadata } from "@blast/server/modules/social/portfolio/coin-metadata.ts";

/**
 * The coins a quote may use (social feed R3-30): USDC and SUI, and the coin of
 * every Blast sale that has migrated to its pool (`lifecycle = 'migrated'`,
 * the product's "trading"), as `SHOWN_PRESALES` shows it, on a venue the app
 * trades (`SOCIAL_TRADE_VENUES`: Cetus, Bluefin, or an Aftermath DAO-fee pool
 * with its pool known), plus every curated ecosystem coin (`CORE_COINS`) and other coins with indexed decimals. The router
 * decides whether those coins have liquidity; a USD price is optional.
 */

export type TradeCoin = Readonly<{
  coinType: string;
  symbol: string;
  decimals: number;
  /** USD per whole coin, R3-20's latest price no older than 120 s (USDC is "1"); null without one. */
  usdPrice: string | null;
  /** The sale it came from, for a sale coin. */
  presaleId: string | null;
  /** The Aftermath AMM pool its sale migrated to, for a sale in a DAO-fee pool: quotes route through it (`aftermath.ts`). */
  aftermathPool: string | null;
}>;

/** A migrated sale's coin by its type: one probe of the shown sales per requested type. */
export const TRADE_SALE_COINS_SQL = `
  SELECT presale_id, sale_token, sale_symbol, sale_decimals, venue, pool_id
  FROM ${SHOWN_PRESALES} p
  WHERE p.sale_token = ANY($1::text[]) AND p.lifecycle = 'migrated' AND p.venue IN ('cetus', 'bluefin', 'aftermath')
    AND (p.venue <> 'aftermath' OR p.pool_id IS NOT NULL)
  ORDER BY p.presale_id`;

/** The latest price of each type, by `chain_read_v1.prices`' key. */
export const TRADE_PRICES_SQL = `
  SELECT coin_type, usd_price::text AS usd_price, as_of_ms::text AS as_of_ms
  FROM ${DISPLAY_PRICES} WHERE coin_type = ANY($1::text[])`;

type SaleCoinRow = Readonly<{
  presale_id: string;
  sale_token: string;
  sale_symbol: string;
  sale_decimals: number;
  venue: string;
  pool_id: string | null;
}>;
type PriceRow = Readonly<{ coin_type: string; usd_price: string; as_of_ms: string }>;

/**
 * The tradable coins among `coinTypes` (canonical), with their fresh prices:
 * batched reads on the replica whatever the count. A type missing from the
 * answer is not tradable.
 */
export async function readTradeCoins(db: ReadableDatabase, coinTypes: readonly string[], nowMs: number): Promise<Map<string, TradeCoin>> {
  const types = [...new Set(coinTypes)];
  const sales = types.filter((type) => type !== SOCIAL_TRADE_BASE_COINS.sui && type !== SOCIAL_TRADE_BASE_COINS.usdc);
  const [saleRows, priceRows] = await Promise.all([
    sales.length ? db.read<SaleCoinRow>(TRADE_SALE_COINS_SQL, [sales]).then((result) => result.rows) : Promise.resolve([] as SaleCoinRow[]),
    db.read<PriceRow>(TRADE_PRICES_SQL, [types.filter((type) => type !== SOCIAL_TRADE_BASE_COINS.usdc)]).then((result) => result.rows),
  ]);
  const fresh = new Map(
    priceRows
      .filter((row) => /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(row.usd_price) && nowMs - Number(row.as_of_ms) <= PORTFOLIO_PRICE_MAX_AGE_MS)
      .map((row) => [row.coin_type, row.usd_price]),
  );
  const coins = new Map<string, TradeCoin>();
  if (types.includes(SOCIAL_TRADE_BASE_COINS.usdc)) {
    coins.set(SOCIAL_TRADE_BASE_COINS.usdc, { coinType: SOCIAL_TRADE_BASE_COINS.usdc, symbol: "USDC", decimals: 6, usdPrice: "1", presaleId: null, aftermathPool: null });
  }
  if (types.includes(SOCIAL_TRADE_BASE_COINS.sui)) {
    const sui = SOCIAL_TRADE_BASE_COINS.sui;
    coins.set(sui, { coinType: sui, symbol: "SUI", decimals: 9, usdPrice: fresh.get(sui) ?? null, presaleId: null, aftermathPool: null });
  }
  for (const row of saleRows) {
    if (coins.has(row.sale_token)) continue;
    coins.set(row.sale_token, {
      coinType: row.sale_token,
      symbol: row.sale_symbol,
      decimals: Number(row.sale_decimals),
      usdPrice: fresh.get(row.sale_token) ?? null,
      presaleId: row.presale_id,
      aftermathPool: row.venue === "aftermath" ? row.pool_id : null,
    });
  }
  const metadata = await readCoinMetadata(db, types.filter((type) => !coins.has(type)));
  for (const coin of metadata.values()) {
    // Presales retain their lifecycle and venue gate, even if their metadata is indexed.
    if (coin.is_presale || coin.decimals === null) continue;
    coins.set(coin.coin_type, {
      coinType: coin.coin_type,
      // A curated coin keeps its curated ticker (suiUSDT, not the indexed USDT), matching its search row.
      symbol: (coreCoin(coin.coin_type)?.symbol || coin.symbol || coin.coin_type.split("::").at(-1)!).slice(0, 32),
      decimals: coin.decimals,
      usdPrice: fresh.get(coin.coin_type) ?? null,
      presaleId: null,
      aftermathPool: null,
    });
  }
  for (const coin of CORE_COINS) {
    const { coinType, symbol, decimals } = coin;
    if (!types.includes(coinType) || coins.has(coinType) || metadata.get(coinType)?.is_presale) continue;
    coins.set(coinType, { coinType, symbol, decimals, usdPrice: fresh.get(coinType) ?? null, presaleId: null, aftermathPool: null });
  }
  return coins;
}
