import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PRICE_MAX_POINTS,
  PRICE_WINDOW_MS,
  PRICE_TIERS,
  PRICE_TIER_SPAN_MS,
  priceStepFor,
  priceTierFor,
  type PricePoint,
  type PriceTier,
  type PriceWindow,
  type SocialPriceHistory,
} from "@blast/core/modules/social/contracts/prices.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { readPoolQuotes } from "@blast/server/modules/social/prices/pool-quotes.ts";
import { recentPriceAtSql, rollingPriceAtSql } from "@blast/server/modules/social/prices/price-at.ts";

/**
 * R3-20's web consumer: a coin's prices over a window, the price 24 hours
 * ago and the price at the day's open, from `chain_read_v1.price_history`
 * and `chain_read_v1.prices` (contract in `contracts/prices.ts`).
 *
 * **Every read is a bounded index range.** blast-infra's view joins its
 * tables to name and price the coin (a quote coin's `pyth` rows; a sale
 * coin's `pool` rows, its pool price and its quote's Pyth price each carried
 * forward by one backward probe a point, c81c5fd), which costs the index
 * order, so an `ORDER BY … LIMIT` cannot stop a scan early (its
 * `docs/deploy.md`): every statement bounds `bucket_ms` on both sides, which
 * keeps each read to one range of the buckets' keys per coin — proportional
 * to the window, never to the coin's history. The read never filters on
 * `source`. The three statements serve any number of coins (one range each,
 * never a statement a coin):
 *
 * - the sales asked for, from `SHOWN_PRESALES` by primary key;
 * - per coin, the price now (`prices` by primary key), the 24h cutoff price
 *   and the UTC day open. The 24h figure prefers the native coin's pool close
 *   repriced at the cutoff, falling back to the newest `5m` bucket in the
 *   preceding hour. The day open uses only the preceding hour's history;
 * - per coin, the window's buckets from one tier (at most
 *   `PRICE_MAX_POINTS + 1` for `5m` and `1h`; `1d` reads the sale's life, a
 *   bucket a day), thinned to evenly spaced ones on the epoch-aligned
 *   `bucket_ms`, at most `PRICE_MAX_POINTS + 2` returned.
 *
 * `loadtest/social-prices-scale.ts` proves the plans at launch scale.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Per coin, the price now, the 24h baseline at `$2` and the UTC day open at `$3`. */
function priceFiguresSql(native: boolean): string {
  const priceAtCutoff = native ? rollingPriceAtSql : recentPriceAtSql;
  return `SELECT k.ord::int AS ord, trim_scale(p.usd_price)::text AS price_usd,
    p.as_of_ms::text AS price_as_of_ms,
    open_24h.bucket_ms || ' ' || trim_scale(open_24h.usd_price) AS at_24h,
    (SELECT bucket_ms || ' ' || trim_scale(usd_price) FROM (${recentPriceAtSql("k.coin_type", "$3::bigint")}) open) AS at_day_open
  FROM unnest($1::text[]) WITH ORDINALITY AS k(coin_type, ord)
  LEFT JOIN chain_read_v1.prices p ON p.coin_type = k.coin_type
  LEFT JOIN LATERAL (${priceAtCutoff("k.coin_type", "$2::bigint")}) open_24h ON TRUE
  ORDER BY k.ord`;
}

export const PRICE_FIGURES_SQL = priceFiguresSql(true);
export const PORTFOLIO_PRICE_FIGURES_SQL = priceFiguresSql(false);

/**
 * The series statement: per window, one tier's buckets in `(lo, hi]` whose
 * price was published after `after` and by `hi`, kept when on the step or at
 * or before `head` (the bucket holding the window's start).
 */
export const PRICE_SERIES_SQL = `SELECT k.ord::int AS ord, h.as_of_ms::text AS as_of_ms, trim_scale(h.usd_price)::text AS usd_price
  FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[])
    WITH ORDINALITY AS k(coin_type, resolution, lo, hi, step, head, after, ord)
  CROSS JOIN LATERAL (
    SELECT ph.bucket_ms, ph.as_of_ms, ph.usd_price
    FROM chain_read_v1.price_history ph
    WHERE ph.coin_type = k.coin_type AND ph.resolution = k.resolution
      AND ph.bucket_ms > k.lo AND ph.bucket_ms <= k.hi AND ph.as_of_ms > k.after AND ph.as_of_ms <= k.hi
      AND (ph.bucket_ms % k.step = 0 OR ph.bucket_ms <= k.head)
    ORDER BY ph.bucket_ms
    LIMIT ${PRICE_MAX_POINTS + 2}
  ) h
  ORDER BY k.ord, h.bucket_ms`;

/** The sales asked for that the web shows and that trade, with their coin and when they started trading. */
export const PRICE_PRESALES_SQL = `SELECT s.presale_id, s.sale_token, l.timestamp_ms::text AS launched_ms
  FROM ${SHOWN_PRESALES} s
  LEFT JOIN chain_read_v1.presale_lifecycle l ON l.presale_id = s.presale_id AND l.state = 'migrated'
  WHERE s.presale_id = ANY($1::text[]) AND s.lifecycle = 'migrated'`;

/** The most recent 00:00 UTC at or before `ms`. */
export function dayOpenAt(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

/** `'<bucket_ms> <usd_price>'` split, or nulls. */
function priceAt(text: string | null): Readonly<{ bucketMs: number; usd: string }> | null {
  if (text === null) return null;
  const [bucket, usd] = text.split(" ");
  return bucket === undefined || usd === undefined ? null : { bucketMs: Number(bucket), usd };
}

export type PriceKey = Readonly<{ presaleId: string | null; coinType: string; launchedMs: number | null }>;

/**
 * What a window reads for one key: its tier, the bucket range `(lo, hi]`,
 * the step it keeps, the bucket holding its start (`head`, always kept) and
 * the instant its prices come after (`after`).
 */
export type PriceWindowPlan = Readonly<{ tier: PriceTier; from: number; lo: number; hi: number; step: number; head: number; after: number }>;

/** The window a key reads: a fixed range, or since the sale started trading (null without a launch time). */
export function windowPlan(window: PriceWindow, key: PriceKey, clockMs: number, points: number, interval?: PriceTier): PriceWindowPlan | null {
  const plan = (from: number, after: number): PriceWindowPlan => {
    const span = clockMs - from;
    // Never request a finer tier than the bounded read can cover.
    const automatic = priceTierFor(span);
    const tier = interval && PRICE_TIERS.indexOf(interval) > PRICE_TIERS.indexOf(automatic) ? interval : automatic;
    const width = PRICE_TIER_SPAN_MS[tier];
    // The bucket holding `from` starts at most one span before it.
    const lo = from - width;
    return { tier, from, lo, hi: clockMs, step: priceStepFor(span, tier, points), head: lo + width, after };
  };
  // Fixed ranges select observations after their starting instant.
  if (window !== "launch") return plan(clockMs - PRICE_WINDOW_MS[window], clockMs - PRICE_WINDOW_MS[window]);
  if (key.launchedMs === null || key.launchedMs > clockMs) return null;
  // A sale's coin has no price before its launch: its line opens on its first trade.
  return plan(key.launchedMs, key.launchedMs - 1);
}

type PresaleRow = Readonly<{ presale_id: string; sale_token: string; launched_ms: string | null }>;
type FigureRow = Readonly<{ ord: number; price_usd: string | null; price_as_of_ms: string | null; at_24h: string | null; at_day_open: string | null }>;
type SeriesRow = Readonly<{ ord: number; as_of_ms: string; usd_price: string }>;

/** The keys the request names, in its order: sales (shown and trading) first as asked, then coins. */
export async function readPriceKeys(
  db: ReadableDatabase,
  request: Readonly<{ presales: readonly string[]; coins: readonly string[] }>,
): Promise<PriceKey[]> {
  const sales = request.presales.length
    ? new Map((await db.read<PresaleRow>(PRICE_PRESALES_SQL, [request.presales])).rows.map((row) => [row.presale_id, row]))
    : new Map<string, PresaleRow>();
  const keys: PriceKey[] = [];
  for (const id of request.presales) {
    const row = sales.get(id);
    if (row) keys.push({ presaleId: id, coinType: row.sale_token, launchedMs: row.launched_ms === null ? null : Number(row.launched_ms) });
  }
  for (const coin of request.coins) keys.push({ presaleId: null, coinType: coin, launchedMs: null });
  return keys;
}

/**
 * Each key's series and figures over `window`, ending at `clockMs`: two
 * statements whatever the number of keys.
 */
export async function readPriceHistories(
  db: ReadableDatabase,
  keys: readonly PriceKey[],
  options: Readonly<{ window: PriceWindow; clockMs: number; points: number; interval?: PriceTier }>,
): Promise<SocialPriceHistory[]> {
  if (keys.length === 0) return [];
  const { window, clockMs, points } = options;
  const coins = [...new Set(keys.map((key) => key.coinType))];
  const figureRows = (await db.read<FigureRow>(PRICE_FIGURES_SQL, [coins, clockMs - DAY, dayOpenAt(clockMs)])).rows;
  const figures = new Map(figureRows.map((row) => [coins[row.ord - 1]!, row]));

  const plans = keys.map((key) => windowPlan(window, key, clockMs, points, options.interval));
  const planned = keys.flatMap((key, index) => (plans[index] ? [{ index, key, plan: plans[index]! }] : []));
  const series = new Map<number, PricePoint[]>();
  if (planned.length) {
    const rows = (await db.read<SeriesRow>(PRICE_SERIES_SQL, [
      planned.map((entry) => entry.key.coinType),
      planned.map((entry) => entry.plan.tier),
      planned.map((entry) => entry.plan.lo),
      planned.map((entry) => entry.plan.hi),
      planned.map((entry) => entry.plan.step),
      planned.map((entry) => entry.plan.head),
      planned.map((entry) => entry.plan.after),
    ])).rows;
    for (const row of rows) {
      const index = planned[row.ord - 1]!.index;
      const list = series.get(index) ?? [];
      list.push([Number(row.as_of_ms), row.usd_price]);
      series.set(index, list);
    }
  }

  const usdHistories: SocialPriceHistory[] = keys.flatMap((key, index) => {
    const figure = figures.get(key.coinType);
    const now = figure?.price_usd ?? null;
    const dayAgo = priceAt(figure?.at_24h ?? null);
    const dayOpen = priceAt(figure?.at_day_open ?? null);
    const plan = plans[index];
    // A coin with no price at all has nothing to show.
    if (now === null && dayAgo === null && !series.get(index)?.length) return [];
    const line: PricePoint[] = [];
    if (plan) {
      // The 24 h window opens on the price at its start; a sale's opens on its first trade.
      if (window === "24h" && dayAgo) line.push([plan.from, dayAgo.usd]);
      line.push(...(series.get(index) ?? []));
      // Both end on the price now, the figure the change compares.
      if (now !== null && (line.length === 0 || line[line.length - 1]![0] < clockMs)) line.push([clockMs, now]);
    }
    return [{
      presale_id: key.presaleId,
      coin_type: key.coinType,
      tier: plan?.tier ?? "5m",
      from_ms: plan?.from ?? clockMs,
      points: line.length >= 2 ? line : [],
      price_usd: now,
      ...(figure?.price_as_of_ms != null ? { price_as_of_ms: Number(figure.price_as_of_ms) } : {}),
      price_24h_usd: dayAgo?.usd ?? null,
      change_24h_bps: changeBps(now, dayAgo?.usd ?? null),
      day_open_usd: dayOpen?.usd ?? null,
      day_open_ms: dayOpen?.bucketMs ?? null,
    }];
  });
  const usdByKey = new Map(usdHistories.map((history) => [history.presale_id ?? history.coin_type, history]));
  const unpriced = keys.filter((key) => key.presaleId !== null && !usdByKey.get(key.presaleId)?.price_usd);
  const quotes = await readPoolQuotes(db, unpriced, options);
  return keys.flatMap((key, index) => {
    const usd = usdByKey.get(key.presaleId ?? key.coinType);
    const quote = key.presaleId === null ? undefined : quotes.get(key.presaleId);
    if (!quote) return usd ? [usd] : [];
    const plan = plans[index];
    return [{ ...(usd ?? {
      presale_id: key.presaleId, coin_type: key.coinType, tier: plan?.tier ?? "5m",
      from_ms: plan?.from ?? clockMs, points: [], price_usd: null, price_24h_usd: null,
      change_24h_bps: null, day_open_usd: null, day_open_ms: null,
    }), quote }];
  });
}
