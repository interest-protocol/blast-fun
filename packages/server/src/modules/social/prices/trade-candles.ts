import type { PresaleVenue } from "@blast/core/modules/presale/contracts/wire.ts";
import { z } from "zod";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  TRADE_CANDLE_LIMIT,
  TRADE_TICK_LIMIT,
  type TradeCandlePage,
} from "@blast/core/modules/social/contracts/trade-candles.ts";
import {
  CANDLE_INTERVALS,
  candleIntervalMs,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";
import {
  PRICE_WINDOWS,
  PRICE_WINDOW_MS,
  priceTierFor,
} from "@blast/core/modules/social/contracts/prices.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export function parseTradeCandlesQuery(url: URL) {
  const read = <T>(name: string, schema: z.ZodType<T>) =>
    socialParameter(
      z.array(schema).max(1),
      url.searchParams.getAll(name),
      name,
    )[0];
  const allowed = new Set([
    "format",
    "coin",
    "presale",
    "window",
    "interval",
    "source",
    "at",
  ]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key)))
    throw new SocialRouteError("invalid_parameter");
  const format = read("format", z.literal("ohlcv"));
  const coin = read("coin", z.string().regex(COIN_TYPE));
  if (!format || !coin) throw new SocialRouteError("invalid_parameter");
  const source = read("source", z.literal("pool_swaps"));
  const presale = read("presale", z.string().regex(SUI_OBJECT_ID_PATTERN));
  const window = read("window", z.enum(PRICE_WINDOWS)) ?? "24h";
  const interval =
    read("interval", z.enum(CANDLE_INTERVALS)) ??
    priceTierFor(
      window === "launch" ? PRICE_WINDOW_MS["24h"] : PRICE_WINDOW_MS[window],
    );
  const at = read("at", z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.int()));
  if (at !== undefined && (source !== "pool_swaps" || !presale))
    throw new SocialRouteError("invalid_parameter");
  return { coin, presale: presale ?? null, window, interval, source, ...(at === undefined ? {} : { at }) };
}
export type TradeCandlesRequest = ReturnType<typeof parseTradeCandlesQuery>;

export const TRADE_CANDLE_MARKET_SQL = `SELECT s.presale_id, s.sale_token, s.quote_type, s.quote_symbol,
    s.sale_decimals, s.quote_decimals, s.pool_id, s.venue, l.timestamp_ms::text AS launched_ms,
    EXISTS (SELECT 1 FROM chain_read_v1.coin_unavailable u WHERE u.coin_type = s.sale_token) AS unavailable
  FROM ${SHOWN_PRESALES} s
  LEFT JOIN chain_read_v1.presale_lifecycle l ON l.presale_id = s.presale_id AND l.state = 'migrated'
  WHERE s.sale_token = $1 AND ($2::text IS NULL OR s.presale_id = $2)
    AND s.lifecycle = 'migrated' LIMIT 2`;

/** The index range is capped before aggregation. A cap overflow returns no candles,
 * so a busy bucket can never publish a silently incomplete OHLC or volume.
 * Numeric arithmetic stays in PostgreSQL; JS receives exact decimal strings.
 */
function candleAggregation(ticks: string, priorClose = "NULL::text"): string {
  return `SELECT * FROM (
  WITH ticks AS MATERIALIZED (
${ticks}
  ), valid AS (
    SELECT *, (quote_amount * 10::numeric ^ $6::int)::numeric(180,72)
        / coin_amount / (10::numeric ^ $7::int) AS price,
      quote_amount::numeric(180,72) / (10::numeric ^ $7::int) AS volume
    FROM ticks WHERE NOT ambiguous AND quote_type = $8 AND coin_amount > 0 AND quote_amount > 0
  ), buckets AS (
    SELECT bucket AS at_ms,
      (array_agg(price ORDER BY checkpoint, tx_slot, event_slot, part))[1] AS open,
      max(price) AS high, min(price) AS low,
      (array_agg(price ORDER BY checkpoint DESC, tx_slot DESC, event_slot DESC, part DESC))[1] AS close,
      sum(volume) AS volume, count(*)::int AS trades
    FROM valid GROUP BY bucket ORDER BY bucket DESC LIMIT ${TRADE_CANDLE_LIMIT + 1}
  ) SELECT (SELECT count(*)::int FROM ticks) AS tick_count,
    (SELECT count(*)::int FROM ticks WHERE ambiguous OR quote_type IS DISTINCT FROM $8 OR coin_amount IS NULL
      OR coin_amount <= 0 OR quote_amount IS NULL OR quote_amount <= 0) AS excluded_trades,
    CASE WHEN NOT EXISTS (SELECT FROM ticks) THEN ${priorClose} END AS prior_close,
    coalesce((SELECT jsonb_agg(jsonb_build_object('at_ms', at_ms, 'open', trim_scale(open)::text,
      'high', trim_scale(high)::text, 'low', trim_scale(low)::text, 'close', trim_scale(close)::text,
      'volume', trim_scale(volume)::text, 'trades', trades) ORDER BY at_ms) FROM buckets), '[]'::jsonb) AS candles
) candle_read`;
}

export const TRADE_CANDLES_SQL =
  candleAggregation(`    SELECT a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, 0 AS part,
      a.quote_type, a.coin_amount, a.quote_amount, FALSE AS ambiguous,
      a.timestamp_ms - a.timestamp_ms % $5::bigint AS bucket
    FROM chain_read_v1.presale_pool_swaps a
    WHERE a.coin_type = $1 AND a.presale_id = $9 AND a.pool_id = $10
      AND a.timestamp_ms >= $2::bigint AND a.timestamp_ms <= $3::bigint
      AND a.checkpoint >= coalesce((SELECT checkpoint FROM chain_read_v1.checkpoint_headers
        WHERE timestamp_ms >= $2::bigint ORDER BY timestamp_ms, checkpoint LIMIT 1), $4::bigint + 1)
      AND a.checkpoint <= $4::bigint
    ORDER BY a.checkpoint DESC, a.tx_slot DESC, a.event_slot DESC LIMIT ${TRADE_TICK_LIMIT + 1}`,
  `(SELECT CASE WHEN a.quote_type = $8 AND a.coin_amount > 0 AND a.quote_amount > 0
        THEN trim_scale((a.quote_amount * 10::numeric ^ $6::int)::numeric(180,72)
          / a.coin_amount / (10::numeric ^ $7::int))::text END
      FROM chain_read_v1.presale_pool_swaps a
      WHERE a.coin_type = $1 AND a.presale_id = $9 AND a.pool_id = $10
        AND a.checkpoint <= $4::bigint AND a.timestamp_ms <= $3::bigint
      ORDER BY a.checkpoint DESC, a.tx_slot DESC, a.event_slot DESC LIMIT 1)`);

export const BALANCE_CANDLES_SQL =
  candleAggregation(`    SELECT a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part,
      a.quote_type, a.coin_amount, a.quote_amount,
      EXISTS (SELECT 1 FROM chain_read_v1.activity other
        WHERE other.checkpoint = a.checkpoint AND other.tx_slot = a.tx_slot
          AND other.kind IN ('trade_buy', 'trade_sell') AND other.coin_type <> a.coin_type) AS ambiguous,
      a.timestamp_ms - a.timestamp_ms % $5::bigint AS bucket
    FROM chain_read_v1.activity a
    WHERE a.coin_type = $1 AND a.kind IN ('trade_buy', 'trade_sell')
      AND a.timestamp_ms >= $2::bigint AND a.timestamp_ms <= $3::bigint
      AND a.checkpoint <= $4::bigint
    ORDER BY a.timestamp_ms DESC LIMIT ${TRADE_TICK_LIMIT + 1}`);

type Market = {
  presale_id: string;
  sale_token: string;
  quote_type: string | null;
  quote_symbol: string | null;
  sale_decimals: number | null;
  quote_decimals: number | null;
  launched_ms: string | null;
  unavailable: boolean;
  pool_id: string | null;
  venue: PresaleVenue | null;
};
type Buckets = {
  tick_count: number;
  excluded_trades: number;
  candles: TradeCandlePage["candles"];
  prior_close?: string | null;
};

function validDecimals(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= 38;
}

function migrationPool(market?: Market): TradeCandlePage["pool"] {
  if (!market?.pool_id || !market.venue) return null;
  return { id: market.pool_id, venue: market.venue };
}

export async function readTradeCandles(
  database: ReadableDatabase,
  request: TradeCandlesRequest,
  nowMs: number,
): Promise<TradeCandlePage> {
  const db = chainViewsOnly(database);
  const stamp = (
    await db.read<{
      network: string;
      checkpoint: string | null;
      timestamp_ms: string | null;
      observed_ms: string | null;
    }>(`SELECT network,
    CASE WHEN market_timestamp_ms < presale_timestamp_ms OR
      (market_timestamp_ms = presale_timestamp_ms AND market_checkpoint <= presale_checkpoint)
      THEN market_checkpoint ELSE presale_checkpoint END AS checkpoint,
    CASE WHEN market_timestamp_ms IS NOT NULL AND presale_timestamp_ms IS NOT NULL
      THEN least(market_timestamp_ms, presale_timestamp_ms) END AS timestamp_ms, observed_ms
    FROM chain_read_v1.watermark`)
  ).rows[0];
  if (
    !stamp ||
    stamp.network !== "mainnet" ||
    stamp.checkpoint === null ||
    stamp.timestamp_ms === null ||
    stamp.observed_ms === null
  )
    throw new SocialRouteError("service_unavailable");
  const asOf = {
    checkpoint: Number(stamp.checkpoint),
    timestamp_ms: Number(stamp.timestamp_ms),
    lag_ms: Math.max(Number(stamp.observed_ms) - Number(stamp.timestamp_ms), 0),
  };
  const clock = Math.min(nowMs, asOf.timestamp_ms);
  const markets = (
    await db.read<Market>(TRADE_CANDLE_MARKET_SQL, [
      request.coin,
      request.presale,
    ])
  ).rows;
  const market = markets.length === 1 ? markets[0] : undefined;
  const start =
    request.window === "launch"
      ? Number(market?.launched_ms ?? clock)
      : Math.max(0, clock - PRICE_WINDOW_MS[request.window]);
  const width = candleIntervalMs(request.interval);
  const from = start - (start % width);
  const poolSwaps = request.source === "pool_swaps";
  const page: TradeCandlePage = {
    format: "ohlcv",
    source: poolSwaps ? "chain_pool_swaps" : "chain_trade_activity",
    price_basis: poolSwaps ? "pool_swap" : "transaction_balance_change",
    pool: migrationPool(market),
    network: "mainnet",
    coin_type: request.coin,
    presale_id: market?.presale_id ?? null,
    window: request.window,
    interval: request.interval,
    quote:
      market?.quote_type && market.quote_symbol
        ? { coin_type: market.quote_type, symbol: market.quote_symbol }
        : null,
    status: market ? "available" : "unsupported",
    from_ms: from,
    to_ms: clock,
    candles: [],
    excluded_trades: 0,
    truncated: false,
    as_of: asOf,
  };
  if (!market) return page;
  if (
    market.unavailable ||
    (poolSwaps && !page.pool) ||
    market.launched_ms === null ||
    Number(market.launched_ms) > clock ||
    !page.quote ||
    !validDecimals(market.sale_decimals) ||
    !validDecimals(market.quote_decimals)
  )
    return { ...page, status: "unavailable" };
  const result = (
    await db.read<Buckets>(
      poolSwaps ? TRADE_CANDLES_SQL : BALANCE_CANDLES_SQL,
      [
        request.coin,
        Math.max(from, Number(market.launched_ms)),
        clock,
        asOf.checkpoint,
        candleIntervalMs(request.interval),
        market.sale_decimals,
        market.quote_decimals,
        market.quote_type,
        ...(poolSwaps ? [market.presale_id, market.pool_id] : []),
      ],
    )
  ).rows[0];
  if (!result) throw new SocialRouteError("service_unavailable");
  if (result.tick_count > TRADE_TICK_LIMIT)
    return { ...page, status: "too_many_trades" };
  return {
    ...page,
    candles: result.candles.slice(-TRADE_CANDLE_LIMIT),
    prior_close: result.prior_close ?? undefined,
    excluded_trades: result.excluded_trades,
    truncated: result.candles.length > TRADE_CANDLE_LIMIT,
  };
}
