import { z } from "zod";
import { CANDLE_INTERVALS } from "../../launchpad-contract/venue-history.ts";
import { PRICE_WINDOWS } from "./prices.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/** Candles from indexed Blast sale-coin trades, never sampled pool marks.
 * GET /api/social/prices?format=ohlcv&coin=…&window=7d&interval=1m
 * Prices are quote tokens per whole sale token; volume is quote tokens.
 * Migration pool swaps use individual fills, including routed and round-trip trades.
 * The older balance-change source remains readable during rolling deployments.
 */
export const TRADE_CANDLE_LIMIT = 2000;
export const TRADE_TICK_LIMIT = 100_000;
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
  .max(400);
const time = z.number().int().nonnegative().safe();
export const tradeCandleSchema = z.object({
  at_ms: time,
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  volume: decimal,
  trades: z.number().int().positive().max(TRADE_TICK_LIMIT),
});
export const tradeCandlePageSchema = z
  .object({
    format: z.literal("ohlcv"),
    source: z.enum(["chain_trade_activity", "chain_pool_swaps"]),
    price_basis: z.enum(["transaction_balance_change", "pool_swap"]),
    pool: z
      .object({
        id: z.string().regex(SUI_OBJECT_ID_PATTERN),
        venue: z.enum(["cetus", "bluefin", "aftermath"]),
      })
      .nullable()
      .optional(),
    network: z.literal("mainnet"),
    coin_type: z.string().regex(COIN_TYPE),
    presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullable(),
    window: z.enum(PRICE_WINDOWS),
    interval: z.enum(CANDLE_INTERVALS),
    quote: z
      .object({ coin_type: z.string(), symbol: z.string().min(1).max(128) })
      .nullable(),
    status: z.enum([
      "available",
      "unsupported",
      "unavailable",
      "too_many_trades",
    ]),
    from_ms: time,
    to_ms: time,
    candles: z.array(tradeCandleSchema).max(TRADE_CANDLE_LIMIT),
    prior_close: decimal.nullable().optional(),
    excluded_trades: z.number().int().nonnegative(),
    truncated: z.boolean(),
    as_of: z.object({ checkpoint: time, timestamp_ms: time, lag_ms: time }),
  })
  .refine(
    (page) =>
      page.source === "chain_pool_swaps"
        ? page.price_basis === "pool_swap" &&
          (page.status !== "available" || !!page.pool)
        : page.price_basis === "transaction_balance_change",
    "Inconsistent candle source",
  );
export type TradeCandlePage = z.infer<typeof tradeCandlePageSchema>;
