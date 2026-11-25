import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PRICE_DEFAULT_POINTS,
  PRICE_MAX_COINS,
  PRICE_MAX_POINTS,
  PRICE_MAX_PRESALES,
  PRICE_WINDOWS,
  PRICE_TIERS,
  SOCIAL_PRICES_ROUTE,
  type PriceWindow,
  type PriceTier,
  type SocialPricesResponse,
} from "@blast/core/modules/social/contracts/prices.ts";
import { readAsOf } from "@blast/server/modules/social/items/index.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readPriceHistories, readPriceKeys } from "@blast/server/modules/social/prices/history.ts";
import { parseTradeCandlesQuery, readTradeCandles } from "./trade-candles.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { databaseErrorCause } from "@blast/core/modules/database/retry.ts";

/**
 * How long a pool-swap candle read that hit the statement timeout (57014)
 * answers every caller with that same failure. One busy graduated pool's
 * candles can outlast the replica's budget; without the hold, each open chart
 * retries the same doomed read and starves the replica's other reads.
 */
export const POOL_SWAP_TIMEOUT_HOLD_MS = 30_000;
const POOL_SWAP_TIMEOUT_KEYS = 1_000;

const isStatementTimeout = (error: unknown) =>
  (databaseErrorCause(error) as { code?: unknown } | null)?.code === "57014";

/**
 * Per process: runs `read` for `key` unless that key timed out within the
 * hold, in which case it throws the held error without touching the database.
 */
function statementTimeoutHold(now: () => number) {
  const timedOut = new Map<string, { until: number; error: unknown }>();
  // Expired keys go first; at the cap the oldest key makes room.
  const hold = (key: string, error: unknown) => {
    const failedAt = now();
    for (const [stale, entry] of timedOut) if (entry.until <= failedAt) timedOut.delete(stale);
    if (!timedOut.has(key) && timedOut.size >= POOL_SWAP_TIMEOUT_KEYS) timedOut.delete(timedOut.keys().next().value!);
    timedOut.set(key, { until: failedAt + POOL_SWAP_TIMEOUT_HOLD_MS, error });
    recordMetric("social.prices.timeout_hold", { outcome: "started" });
  };
  return async <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const held = timedOut.get(key);
    if (held && held.until > now()) {
      recordMetric("social.prices.timeout_hold", { outcome: "held" });
      throw held.error;
    }
    try {
      return await read();
    } catch (error) {
      if (isStatementTimeout(error)) hold(key, error);
      throw error;
    }
  };
}

export type PricesRequest = Readonly<{
  presales: readonly string[];
  coins: readonly string[];
  window: PriceWindow;
  points: number;
  interval?: PriceTier;
}>;

const invalid = (parameter: string) => new SocialRouteError("invalid_parameter", { extra: { parameter } });

/**
 * The query from a URL (contract in `contracts/prices.ts`): `presale` and
 * `coin` repeatable (duplicates collapse, order kept), `window` and `points`
 * at most once; others ignored.
 */
export function parsePricesQuery(url: URL): PricesRequest {
  const presales = [...new Set(url.searchParams.getAll("presale"))];
  const coins = [...new Set(url.searchParams.getAll("coin"))];
  socialParameter(z.array(z.string().regex(SUI_OBJECT_ID_PATTERN)).max(PRICE_MAX_PRESALES), presales, "presale");
  socialParameter(z.array(z.string().regex(COIN_TYPE)).max(PRICE_MAX_COINS), coins, "coin");
  if (presales.length + coins.length === 0) throw invalid("presale");
  const windows = url.searchParams.getAll("window");
  const window = socialParameter(z.array(z.enum(PRICE_WINDOWS)).max(1), windows, "window")[0] ?? "24h";
  // A coin has no launch: only a sale's coin started trading at a known time.
  if (window === "launch" && coins.length > 0) throw invalid("window");
  const pointValues = url.searchParams.getAll("points");
  const points = socialParameter(z.array(z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().min(2).max(PRICE_MAX_POINTS))).max(1), pointValues, "points")[0] ?? PRICE_DEFAULT_POINTS;
  const interval = socialParameter(z.array(z.enum(PRICE_TIERS)).max(1), url.searchParams.getAll("interval"), "interval")[0];
  return { presales, coins, window, points, ...(interval ? { interval } : {}) };
}

/** The whole answer, exactly as the route gives it. */
export async function readPrices(database: ReadableDatabase, request: PricesRequest, nowMs: number): Promise<SocialPricesResponse> {
  const db = chainViewsOnly(database);
  const asOf = await readAsOf(db);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  // Windows end at the watermark, never past now.
  const clockMs = Math.min(asOf.timestamp_ms, nowMs);
  const keys = await readPriceKeys(db, request);
  const prices = await readPriceHistories(db, keys, { window: request.window, clockMs, points: request.points, interval: request.interval });
  return { window: request.window, clock_ms: clockMs, prices, as_of: asOf };
}

export type SocialPricesRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production. Resolved per request. */
  database: () => ReadableDatabase;
  now?: () => number;
  publicRead?: <T>(key: string, load: () => Promise<T>, cacheMs: number) => Promise<T>;
}>;

/**
 * `GET /api/social/prices`: public, no authentication (no token or cookie is
 * read), bucket `social_read_prices`, a 200 publicly cached
 * (`SOCIAL_PUBLIC_CACHE_CONTROL`); errors are `no-store`.
 */
export function createSocialPricesRoute(dependencies: SocialPricesRouteDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;
  const publicRead = dependencies.publicRead ?? ((_key, load) => load());
  const timeoutHold = statementTimeoutHold(now);
  return Object.freeze({
    GET: kit.route({ name: SOCIAL_PRICES_ROUTE, auth: "none", bucket: "social_read_prices", cache: "public" }, async (context) => {
      const started = performance.now();
      const url = new URL(context.request.url);
      if (url.searchParams.has("format")) {
        const { at, ...request } = parseTradeCandlesQuery(url);
        const live = at !== undefined;
        // Callers with different checkpoint floors can share the same recent aggregate.
        const key = JSON.stringify({ format: "ohlcv", ...request, ...(live ? { live } : {}) });
        // Live and settled reads of one range run the same query, so they share one hold.
        const holdKey = JSON.stringify({ format: "ohlcv", ...request });
        const read = () => publicRead(key, () => readTradeCandles(database(), request, now()), live ? 1_000 : 10_000);
        const answer = request.source === "pool_swaps" ? await timeoutHold(holdKey, read) : await read();
        if (at !== undefined && answer.as_of.checkpoint < at) throw new SocialRouteError("service_unavailable");
        return context.json(answer);
      }
      const request = parsePricesQuery(url);
      const answer = await publicRead(JSON.stringify(request), () => readPrices(database(), request, now()), 10_000);
      recordMetric("social.prices", {
        window: request.window,
        keys: request.presales.length + request.coins.length,
        found: answer.prices.length,
        ms: Math.round(performance.now() - started),
      });
      return context.json(answer);
    }),
  });
}
