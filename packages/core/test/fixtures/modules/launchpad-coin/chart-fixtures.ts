// The coin fixture's per-pool candles as blast-infra's
// `GET /v1/pools/{venue}/{pool_id}/candles` serves them (schema candles), for
// tests and the dev fixture server only. The Froggy curve trades with a quiet
// spell (intervals without a candle), migrates at the fixture's committed
// `Migrated` (326100000:2:5:0, 2026-09-24 06:06:40 UTC), and its Bluefin pool
// swaps after it, also with a quiet spell. Both trade in the migration's
// minute, so no candle spans it. Candles are built from these trades with
// blast-infra's rules: each open is the previous close (the first trade's
// price first), high and low take in the open, and a bucket without trades
// has no candle.

import type { LaunchLifecycle } from "../../../../src/modules/launchpad-contract/discovery.ts";
import { CANDLE_PAGE, candleIntervalMs, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { CURVE_POOL_KEY, VENUE_POOL_KEY, wireProvenance } from "./fixtures.ts";

type Trade = Readonly<{ at: number; price: string; quote: bigint; meme: bigint; side: "buy" | "sell" }>;

const MINUTE = 60_000;
/** 2026-09-24 06:00:00 UTC, on every interval's grid but the week's. */
const START = 1_790_229_600_000;
const MIGRATED_AT = 1_790_230_000_000;
const MIGRATION_CURSOR = "326100000:2:5:0";

const trade = (minutes: number, price: string, quoteSui: number, side: "buy" | "sell" = "buy"): Trade => {
  const quote = BigInt(Math.round(quoteSui * 1e9));
  return { at: START + Math.round(minutes * MINUTE), price, quote, meme: (quote * 1_000_000n) / BigInt(Math.round(Number(price) * 1e6)), side };
};

/** The curve's trades: none in minutes 3 and 4. All before the migration. */
const CURVE_TRADES: readonly Trade[] = [
  trade(0, "0.0025", 2),
  trade(0.5, "0.0026", 3),
  trade(1, "0.0024", 1, "sell"),
  trade(2.2, "0.0031", 5),
  trade(5, "0.0052", 8),
  trade(5.5, "0.0049", 2, "sell"),
  trade(6.5, "0.01125", 12),
];

/** The Bluefin pool's swaps after the migration: none in minutes 8 to 10, nor 13 to 29. */
const VENUE_TRADES: readonly Trade[] = [
  trade(6.9, "0.015625", 5),
  trade(7.4, "0.0161", 3),
  trade(7.8, "0.0153", 2, "sell"),
  trade(11, "0.0158", 4),
  trade(12.2, "0.0149", 3, "sell"),
  trade(30, "0.0166", 6),
];

const WEEK_SHIFT = 4 * 24 * 60 * MINUTE;

function bucketStart(interval: CandleInterval, at: number): number {
  const ms = candleIntervalMs(interval);
  const shift = interval === "1w" ? WEEK_SHIFT : 0;
  return at - ((((at - shift) % ms) + ms) % ms);
}

function candles(trades: readonly Trade[], interval: CandleInterval) {
  const built: Record<string, unknown>[] = [];
  let close: string | null = null;
  for (const at of [...new Set(trades.map((item) => bucketStart(interval, item.at)))]) {
    const inBucket = trades.filter((item) => bucketStart(interval, item.at) === at);
    const open: string = close ?? inBucket[0].price;
    const prices = [open, ...inBucket.map((item) => item.price)];
    const pick = (better: (a: number, b: number) => boolean) => prices.reduce((kept, price) => (better(Number(price), Number(kept)) ? price : kept));
    close = inBucket.at(-1)!.price;
    const buys = inBucket.filter((item) => item.side === "buy").length;
    built.push({
      bucket_start: at,
      interval,
      open,
      high: pick((a, b) => a > b),
      low: pick((a, b) => a < b),
      close,
      volume_quote: inBucket.reduce((sum, item) => sum + item.quote, 0n).toString(),
      volume_meme: inBucket.reduce((sum, item) => sum + item.meme, 0n).toString(),
      volume_usd: null,
      buys,
      sells: inBucket.length - buys,
      trades: inBucket.length,
    });
  }
  return built;
}

export type CandleFixtureRequest = Readonly<{ interval: CandleInterval; from?: number; to?: number; limit?: number }>;

/**
 * One page of the curve's or the venue pool's candles at `lifecycle`: the
 * newest `limit` that start before `to` and at or after `from`, oldest first,
 * bounded by the committed migration once the launch migrated.
 */
export function candleFixtureBody(
  source: "curve" | "venue",
  lifecycle: LaunchLifecycle,
  request: CandleFixtureRequest,
  now: number,
  options: Readonly<{ lagMs?: number; venuePoolKey?: string | null }> = {},
): Record<string, unknown> {
  const migrated = lifecycle === "migrated";
  const trades = source === "curve" ? CURVE_TRADES : migrated ? VENUE_TRADES : [];
  const limit = Math.min(request.limit ?? CANDLE_PAGE.default, CANDLE_PAGE.max);
  const inRange = candles(trades, request.interval).filter(
    (candle) => (request.from === undefined || (candle.bucket_start as number) >= request.from) && (request.to === undefined || (candle.bucket_start as number) < request.to),
  );
  return {
    provenance: wireProvenance(now, options.lagMs),
    interval: request.interval,
    candles: inRange.slice(Math.max(0, inRange.length - limit)),
    migration: migrated
      ? {
          cursor: MIGRATION_CURSOR,
          timestamp_ms: MIGRATED_AT,
          curve_pool_key: CURVE_POOL_KEY,
          venue_pool_key: options.venuePoolKey === undefined ? VENUE_POOL_KEY : options.venuePoolKey,
        }
      : null,
  };
}
