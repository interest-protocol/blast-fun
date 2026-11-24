import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PricePoint, PriceTier, PriceWindow, SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import { PRICE_MAX_POINTS } from "@blast/core/modules/social/contracts/prices.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { windowPlan, type PriceKey } from "@blast/server/modules/social/prices/history.ts";

export const POOL_QUOTE_FIGURES_SQL = `SELECT p.presale_id, p.quote_type, p.quote_symbol,
    p.price_quote::text AS price_quote, p.as_of_ms::text AS as_of_ms,
    (SELECT h.price_quote::text FROM chain_read_v1.presale_pool_price_history h
     WHERE h.presale_id = p.presale_id AND h.resolution = '5m'
       AND h.bucket_ms <= $2::bigint AND h.as_of_ms <= $2::bigint
     ORDER BY h.bucket_ms DESC LIMIT 1) AS price_24h_quote
  FROM chain_read_v1.presale_pool_prices p WHERE p.presale_id = ANY($1::text[])
    AND p.as_of_ms <= $3::bigint`;

export const POOL_QUOTE_SERIES_SQL = `SELECT k.ord::int AS ord, h.as_of_ms::text AS as_of_ms,
    h.price_quote::text AS price_quote
  FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[])
    WITH ORDINALITY AS k(presale_id, resolution, lo, hi, step, after, ord)
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON ((ph.bucket_ms - k.lo) / k.step) ph.as_of_ms, ph.price_quote
    FROM chain_read_v1.presale_pool_price_history ph
    WHERE ph.presale_id = k.presale_id AND ph.resolution = k.resolution
      AND ph.bucket_ms > k.lo AND ph.bucket_ms <= k.hi
      AND ph.as_of_ms > k.after AND ph.as_of_ms <= k.hi
    ORDER BY (ph.bucket_ms - k.lo) / k.step, ph.as_of_ms DESC
    LIMIT ${PRICE_MAX_POINTS + 2}
  ) h ORDER BY k.ord, h.as_of_ms`;

type Figure = Readonly<{ presale_id: string; quote_type: string; quote_symbol: string; price_quote: string; as_of_ms: string; price_24h_quote: string | null }>;
type Observation = Readonly<{ ord: number; as_of_ms: string; price_quote: string }>;

/** An unpriced quote stays in its own units; only real indexed pool observations form its line. */
export async function readPoolQuotes(db: ReadableDatabase, keys: readonly PriceKey[], options: Readonly<{ window: PriceWindow; clockMs: number; points: number; interval?: PriceTier }>): Promise<ReadonlyMap<string, NonNullable<SocialPriceHistory["quote"]>>> {
  const sales = keys.filter((key) => key.presaleId !== null);
  if (sales.length === 0) return new Map();
  const { window, clockMs, points } = options;
  try {
    const figures = (await db.read<Figure>(POOL_QUOTE_FIGURES_SQL, [sales.map((key) => key.presaleId), clockMs - 86_400_000, clockMs])).rows;
    if (figures.length === 0) return new Map();
    const available = new Set(figures.map((row) => row.presale_id));
    const plans = sales.flatMap((key) => {
      const plan = windowPlan(window, key, clockMs, points, options.interval);
      return plan && available.has(key.presaleId!) ? [{ key, plan }] : [];
    });
    const lines = new Map<string, PricePoint[]>();
    if (plans.length) {
      const observations = (await db.read<Observation>(POOL_QUOTE_SERIES_SQL, [
        plans.map(({ key }) => key.presaleId), plans.map(({ plan }) => plan.tier),
        plans.map(({ plan }) => plan.lo), plans.map(({ plan }) => plan.hi),
        plans.map(({ plan }) => plan.step), plans.map(({ plan }) => plan.after),
      ])).rows;
      for (const row of observations) {
        const id = plans[row.ord - 1]!.key.presaleId!;
        const line = lines.get(id) ?? [];
        line.push([Number(row.as_of_ms), row.price_quote]);
        lines.set(id, line);
      }
    }
    return new Map(figures.map((row) => [row.presale_id, {
      coin_type: row.quote_type, symbol: row.quote_symbol, price: row.price_quote,
      as_of_ms: Number(row.as_of_ms), points: lines.get(row.presale_id) ?? [],
      change_24h_bps: Number(row.as_of_ms) > clockMs - 86_400_000 ? changeBps(row.price_quote, row.price_24h_quote) : null,
    }]));
  } catch (error) {
    // Infra's additive views deploy first; until then keep existing USD reads usable.
    if (error instanceof Error && "code" in error && error.code === "42P01") return new Map();
    throw error;
  }
}
