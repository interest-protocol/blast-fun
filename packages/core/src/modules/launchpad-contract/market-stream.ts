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
  heartbeatMs: 15_000,
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
