import { z } from "zod";
import { COIN_TYPE_WITH_GENERICS, SUI_OBJECT_ID_PATTERN } from "../../lib/sui/ids.ts";
import { EVENT_CURSOR } from "./cursor.ts";
import { POOL_KEY } from "./venues.ts";

/** One browser stream covers the chart's curve and optional recorded venue pool. */
export const MARKET_STREAM_BUDGET = Object.freeze({
  maxPoolsPerClient: 2,
  maxPriceCoinsPerClient: 20,
  maxPriceCoins: 128,
  maxTopics: 64,
  maxUpstreamFrameChars: 131_072,
  maxChunkBytes: 16_384,
  queueBytesPerClient: 65_536,
  heartbeatMs: 4_000,
  heartbeatTimeoutMs: 9_000,
  lifetimeMs: 270_000,
});
export const MARKET_STREAM_PATH = "/api/launchpad/market/stream";
export const MARKET_STREAM_ROUTE_ID = "launchpad.market.stream";

export const displayPriceCoinSchema = z.string().max(320).regex(/^[\w:<>,]+$/).regex(COIN_TYPE_WITH_GENERICS);
export const displayPriceSchema = z.object({
  coin_type: displayPriceCoinSchema,
  usd_price: z.string().max(128).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
  as_of_ms: z.number().int().positive(),
});
export type DisplayPrice = Readonly<z.infer<typeof displayPriceSchema>>;
export const displayPriceFrameSchema = z.object({
  checkpoint: z.number().int().nonnegative(),
  prices: z.array(displayPriceSchema).max(MARKET_STREAM_BUDGET.maxPriceCoinsPerClient),
});
export type DisplayPriceFrame = Readonly<z.infer<typeof displayPriceFrameSchema>>;
const decimal = z.string().max(80).regex(/^-?\d+(\.\d+)?$/).nullable();
const count = z.number().int().nonnegative().nullable();
/**
 * `coin_stats` (protocol.md section 4): a coin's numbers after a checkpoint. State, not log:
 * the latest wins, it is never replayed, and the relay sends it outside the cursor order.
 */
export const coinStatsFrameSchema = z.object({
  type: z.literal("coin_stats"),
  coin: displayPriceCoinSchema,
  pool_key: z.string().regex(POOL_KEY),
  checkpoint: z.number().int().nonnegative(),
  timestamp_ms: z.number().int().nonnegative(),
  cursor: z.string().regex(EVENT_CURSOR),
  lifecycle: z.string().max(32).nullable(),
  price: decimal,
  market_cap: decimal,
  market: z.object({ market_cap_usd: decimal, fdv_usd: decimal, change_24h_bps: z.number().int().nullable() }).partial().nullable(),
  quote_usd: z.record(z.string().max(64), z.unknown()).nullable(),
  window_24h: z.object({ volume_quote: decimal, volume_usd: decimal, buys: count, sells: count, trades: count }).partial().nullable(),
  holders: count,
  progress_bps: z.number().int().min(0).max(10_000).nullable(),
  liquidity_quote: decimal,
}).partial({ lifecycle: true, price: true, market_cap: true, market: true, quote_usd: true, window_24h: true, holders: true, progress_bps: true, liquidity_quote: true });
export type CoinStatsFrame = Readonly<z.infer<typeof coinStatsFrameSchema>>;
export const displayPriceSnapshotSchema = z.object({
  prices: z.array(z.unknown()).max(MARKET_STREAM_BUDGET.maxPriceCoins),
  provenance: z.unknown(),
});

export function marketStreamEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = environment.BLAST_BACKEND_MARKET_STREAM_ENABLED;
  if (value !== undefined && value !== "false" && value !== "true")
    throw new Error(
      "BLAST_BACKEND_MARKET_STREAM_ENABLED must be true or false.",
    );
  return value === "true";
}

export function marketStreamActivity(request: Request): boolean {
  const values = new URL(request.url).searchParams.getAll("activity");
  if (values.length > 1 || (values.length === 1 && values[0] !== "true"))
    throw new Error("Invalid activity subscription.");
  return values.length === 1;
}

/** A tab may stream one presale alongside its regular market subscriptions. */
export function marketStreamPresale(request: Request): string | null {
  const values = new URL(request.url).searchParams.getAll("presale");
  if (values.length > 1 || (values.length === 1 && !SUI_OBJECT_ID_PATTERN.test(values[0]!))) {
    throw new Error("Invalid presale subscription.");
  }
  return values[0] ?? null;
}

/** Browser reconnects use REST recovery, rather than sharing one subscriber's resume cursor. */
export function marketStreamPools(request: Request): readonly string[] {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some(
      (key) => key !== "pool" && key !== "cursor" && key !== "activity" && key !== "price_coin" && key !== "presale",
    )
  )
    throw new Error("Invalid market stream query.");
  marketStreamActivity(request);
  const pools = params.getAll("pool");
  const presale = marketStreamPresale(request);
  const cursor = params.getAll("cursor");
  const lastId = request.headers.get("last-event-id");
  if (
    (!pools.length && !presale && !marketStreamActivity(request)) ||
    pools.length > MARKET_STREAM_BUDGET.maxPoolsPerClient ||
    new Set(pools).size !== pools.length ||
    pools.some((pool) => !POOL_KEY.test(pool)) ||
    cursor.length > 1 ||
    (cursor.length && !EVENT_CURSOR.test(cursor[0]!)) ||
    (lastId !== null && !EVENT_CURSOR.test(lastId))
  )
    throw new Error("Invalid market stream query.");
  return pools;
}

export function marketStreamPriceCoins(request: Request): readonly string[] {
  const coins = new URL(request.url).searchParams.getAll("price_coin");
  if (
    coins.length > MARKET_STREAM_BUDGET.maxPriceCoinsPerClient ||
    new Set(coins).size !== coins.length ||
    coins.some((coin) => !displayPriceCoinSchema.safeParse(coin).success)
  ) throw new Error("Invalid market price subscription.");
  return coins;
}
