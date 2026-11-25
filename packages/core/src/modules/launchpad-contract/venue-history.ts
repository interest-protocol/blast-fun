import { z } from "zod";
import { compareExact, exactDecimal } from "@blast/core/lib/exact-amount.ts";
import { fdvInQuote } from "@blast/core/modules/social/prices/valuation.ts";
import { isStandalonePool } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { marketCapUsd, quoteValueUsd } from "./market-cap-usd.ts";
import { matchesSchema, listSchema, contractObject, contractValue, recordSchema, ContractViolation, parseAtomic, parseCount, parsePriceString, parseUsdString } from "@blast/core/modules/launchpad-contract/decimal.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { CursorError, EVENT_CURSOR, compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { sectionFromRead, type Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { readV1, type V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN, SUI_OBJECT_ID_SOURCE } from "@blast/core/lib/sui/ids.ts";
import { MIGRATOR_POOL_KEY, POOL_KEY, type Venue } from "./venues.ts";

/**
 * A migrated launch's durable market history from blast-infra's `/v1` (its
 * docs/api.md "GET /v1/pools/{venue}/{pool_id}/candles" and ".../trades"),
 * one source at a time: the curve's pool, or the venue pool its migration
 * recorded (Cetus CLMM or Bluefin Spot). The terminal reads each pool's own
 * chart, never the coin's merged one.
 *
 * - A pool's candles are its own trades': a bucket without trades has no
 *   candle (a gap stays a gap, through a venue outage too), each open is the
 *   previous candle's close, `high` and `low` take in the open, and
 *   `buys + sells = trades ≥ 1`.
 * - Every page names the migration that bounds it (`migration`): the
 *   `Migrated` cursor and checkpoint time, the curve's pool key and the venue
 *   pool the migration recorded. A curve candle starts no later than the
 *   migration and holds only trades before it; a venue candle ends after it
 *   and holds only swaps after it. A venue page without the migration, or
 *   naming another pool, is refused. The four Blast V1 pools have their own
 *   native swap history and carry no V2 migration marker.
 * - Venue activity is the venue pool's own completed swaps, newest first.
 *   Only the trade's immutable whale flag is retained.
 *
 * `readMigratedChart` reads both sources independently: a venue that is
 * unavailable (an outage, a refusal, a contract violation or an answer about
 * another route) leaves the curve's chart and the migration marker readable,
 * and is never shown as an empty chart.
 */

export const CANDLE_INTERVALS = ["1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS: Readonly<Record<CandleInterval, number>> = {
  "1s": SECOND,
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1d": DAY,
  "1w": 7 * DAY,
};
/** One candle's length: a bucket of `interval`, in milliseconds. */
export function candleIntervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}
/** Weeks start on Monday 00:00 UTC, four days after the Unix epoch. */
const WEEK_START = 4 * DAY;

export const CANDLE_PAGE = Object.freeze({ default: 500, max: 2000 });
export const TRADE_PAGE = Object.freeze({ default: 50, max: 200 });

const CURVE_KEY = new RegExp(`^blast_curve:${SUI_OBJECT_ID_SOURCE}$`);
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The committed migration a chart is bounded by, and the route it recorded. */
export type MigrationMarker = Readonly<{
  /** The `Migrated` event's cursor: the launch's native migration position. */
  cursor: string;
  /** Its checkpoint's timestamp. */
  timestampMs: number;
  curvePoolKey: string;
  /** The recorded venue pool; null when the migration opened none blast-infra tracks. */
  venuePoolKey: string | null;
}>;

export type Candle = Readonly<{
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeQuote: bigint;
  volumeMeme: bigint;
  volumeUsd: string | null;
  buys: number;
  sells: number;
  trades: number;
}>;

/** One pool's chart page: its source, oldest first, and the migration that bounds it. */
export type PoolCandlePage = Readonly<{
  poolKey: string;
  source: "curve" | "venue";
  venue: Venue;
  interval: CandleInterval;
  candles: readonly Candle[];
  migration: MigrationMarker | null;
}>;

/** One completed trade of a pool's tape. */
export type PoolTrade = Readonly<{
  cursor: string;
  timestampMs: number;
  digest: string;
  trader: string | null;
  whale?: true;
  side: "buy" | "sell";
  kind: string;
  quoteAmount: bigint;
  memeAmount: bigint;
  price: string | null;
  volumeUsd: string | null;
  /** The swap's post-trade USD cap, when its quote units and USD stamp are available. */
  marketCapUsd?: string | null;
  fdvUsd?: string | null;
  /** A venue swap's raw fields; null on curve trades. */
  venueSwap: Readonly<{
    amountIn: bigint;
    amountOut: bigint;
    refAmount: bigint | null;
    beforeSqrtPrice: bigint;
    afterSqrtPrice: bigint;
    aToB: boolean;
  }> | null;
}>;

export type CoinCandlePage = Readonly<{ coinType: string; interval: CandleInterval; candles: readonly Candle[]; migration: MigrationMarker | null }>;

export type PoolTradesPage = Readonly<{ poolKey: string; trades: readonly PoolTrade[] }>;

export type CandleRequest = Readonly<{ interval: CandleInterval; from?: number; to?: number; limit?: number }>;
export type TradeRequest = Readonly<{ before?: string; limit?: number }>;

const cursorSchema = z.string().regex(EVENT_CURSOR);
const curveKeySchema = z.string().regex(CURVE_KEY);
const venueKeySchema = z.string().regex(MIGRATOR_POOL_KEY);
const digestSchema = z.string().regex(DIGEST);
const traderSchema = z.string().regex(SUI_OBJECT_ID_PATTERN).nullable();

function record(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string, optional: readonly string[] = []): void {
  contractObject(value, field, keys, optional);
}

/** The exact order of two canonical prices: negative, zero or positive. */
export function comparePrices(left: string, right: string): number {
  return compareExact(exactDecimal(left)!, exactDecimal(right)!);
}

/** The start of the `interval` bucket that holds `timestampMs` (weeks start on Monday 00:00 UTC). */
export function candleBucketStart(interval: CandleInterval, timestampMs: number): number {
  const ms = INTERVAL_MS[interval];
  const offset = interval === "1w" ? (ms - WEEK_START) % ms : 0;
  return timestampMs - ((timestampMs % ms) + offset) % ms;
}

function splitKey(poolKey: string): [Venue, string] {
  const match = POOL_KEY.exec(poolKey);
  if (!match) throw new CursorError("pool must be a pool key <venue>:<pool_id>");
  return [match[1] as Venue, match[2]];
}

function poolPath(poolKey: string): string {
  const [venue, poolId] = splitKey(poolKey);
  return `/v1/pools/${venue}/${poolId}`;
}

function boundedLimit(limit: number | undefined, bounds: Readonly<{ default: number; max: number }>): number {
  if (limit === undefined) return bounds.default;
  if (!matchesSchema(z.number().int().min(1).max(bounds.max), limit)) {
    throw new CursorError(`limit must be a whole number from 1 to ${bounds.max}`);
  }
  return limit;
}

function millis(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!matchesSchema(z.number().int().nonnegative(), value))) {
    throw new CursorError(`${name} must be milliseconds since the Unix epoch`);
  }
  return value;
}

/** The path of one page of a pool's candles: `limit` back from `to` (exclusive), at or after `from`. */
function candleQuery(request: CandleRequest): string {
  if (!matchesSchema(z.enum(CANDLE_INTERVALS), request.interval)) throw new CursorError(`interval must be one of ${CANDLE_INTERVALS.join(", ")}`);
  const from = millis(request.from, "from");
  const to = millis(request.to, "to");
  if (from !== undefined && to !== undefined && from >= to) throw new CursorError("from must be before to");
  const params = new URLSearchParams({ interval: request.interval, limit: String(boundedLimit(request.limit, CANDLE_PAGE)) });
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(to));
  return params.toString();
}

export function poolCandlesPath(poolKey: string, request: CandleRequest): string {
  return `${poolPath(poolKey)}/candles?${candleQuery(request)}`;
}

/** The authoritative merged swap history; never derived from sampled spot prices. */
export function coinCandlesPath(coinType: string, request: CandleRequest): string {
  if (!COIN_TYPE.test(coinType)) throw new CursorError("coin must be a canonical coin type");
  return `/v1/coins/${coinType}/candles?${candleQuery(request)}`;
}

export function parseCoinCandlePage(coinType: string, interval: CandleInterval, body: unknown): CoinCandlePage {
  coinCandlesPath(coinType, { interval });
  const answer = record(body, "body");
  exactKeys(answer, ["interval", "candles", "migration"], "body", ["provenance"]);
  if (answer.interval !== interval) throw new ContractViolation("interval", "must be the requested interval");
  const rows = contractValue(listSchema.max(CANDLE_PAGE.max), answer.candles, "candles", "must be a bounded list");
  const candles = rows.map((row, index) => parseCandle(row, interval, `candles[${index}]`));
  candles.slice(1).forEach((candle, index) => {
    if (candle.bucketStart <= candles[index].bucketStart || candle.open !== candles[index].close)
      throw new ContractViolation(`candles[${index + 1}]`, "must be oldest first and open at the previous close");
  });
  return { coinType, interval, candles, migration: parseMarker(answer.migration, "migration") };
}

export function readCoinCandles(coinType: string, request: CandleRequest, dependencies: MarketDataDependencies) {
  return readV1("market", coinCandlesPath(coinType, request), (body) => parseCoinCandlePage(coinType, request.interval, body), dependencies);
}

/** The path of one page of a pool's trades, newest first, strictly before `before`. */
export function poolTradesPath(poolKey: string, request: TradeRequest): string {
  const params = new URLSearchParams({ limit: String(boundedLimit(request.limit, TRADE_PAGE)) });
  if (request.before !== undefined) {
    if (!matchesSchema(z.string().regex(EVENT_CURSOR), request.before)) throw new CursorError("before must be a trade cursor");
    params.set("before", request.before);
  }
  return `${poolPath(poolKey)}/trades?${params.toString()}`;
}

function parseMarker(value: unknown, field: string): MigrationMarker | null {
  if (value === null) return null;
  const marker = record(value, field);
  exactKeys(marker, ["cursor", "timestamp_ms", "curve_pool_key", "venue_pool_key"], field);
  if (!matchesSchema(cursorSchema, marker.cursor)) throw new ContractViolation(`${field}.cursor`, "must be a cursor");
  if (!matchesSchema(curveKeySchema, marker.curve_pool_key)) {
    throw new ContractViolation(`${field}.curve_pool_key`, "must be a curve pool key");
  }
  const venue = marker.venue_pool_key;
  if (venue !== null && (!matchesSchema(venueKeySchema, venue))) {
    throw new ContractViolation(`${field}.venue_pool_key`, "must be a Cetus or Bluefin pool key or null");
  }
  return {
    cursor: marker.cursor,
    timestampMs: parseCount(marker.timestamp_ms, `${field}.timestamp_ms`),
    curvePoolKey: marker.curve_pool_key,
    venuePoolKey: venue as string | null,
  };
}

function parseCandle(value: unknown, interval: CandleInterval, field: string): Candle {
  const candle = record(value, field);
  exactKeys(
    candle,
    ["bucket_start", "interval", "open", "high", "low", "close", "volume_quote", "volume_meme", "volume_usd", "buys", "sells", "trades"],
    field,
  );
  if (candle.interval !== interval) throw new ContractViolation(`${field}.interval`, "must be the page's interval");
  const bucketStart = parseCount(candle.bucket_start, `${field}.bucket_start`);
  if (candleBucketStart(interval, bucketStart) !== bucketStart) throw new ContractViolation(`${field}.bucket_start`, "must start a bucket of the interval");
  const price = (key: string) => parsePriceString(candle[key], `${field}.${key}`);
  const [open, high, low, close] = [price("open"), price("high"), price("low"), price("close")];
  if (![open, close, low].every((value) => comparePrices(value, high) <= 0) || ![open, close].every((value) => comparePrices(value, low) >= 0)) {
    throw new ContractViolation(`${field}.high`, "high and low bound the open and the close");
  }
  const buys = parseCount(candle.buys, `${field}.buys`);
  const sells = parseCount(candle.sells, `${field}.sells`);
  const trades = parseCount(candle.trades, `${field}.trades`);
  if (trades === 0 || buys + sells !== trades) {
    throw new ContractViolation(`${field}.trades`, "a candle has trades, and they are its buys and sells: an interval without trades has none");
  }
  return {
    bucketStart,
    open,
    high,
    low,
    close,
    volumeQuote: parseAtomic(candle.volume_quote, `${field}.volume_quote`),
    volumeMeme: parseAtomic(candle.volume_meme, `${field}.volume_meme`),
    volumeUsd: candle.volume_usd === null ? null : parseUsdString(candle.volume_usd, `${field}.volume_usd`),
    buys,
    sells,
    trades,
  };
}

/**
 * A validated page of `poolKey`'s own `interval` candles: oldest first, each
 * open the previous close, no empty interval, and every candle on its side
 * of the migration the page names.
 */
export function parsePoolCandlePage(poolKey: string, interval: CandleInterval, body: unknown): PoolCandlePage {
  const [venue] = splitKey(poolKey);
  const source = venue === "blast_curve" ? "curve" : "venue";
  const answer = record(body, "body");
  exactKeys(answer, ["interval", "candles", "migration"], "body", ["provenance"]);
  if (answer.interval !== interval) throw new ContractViolation("interval", "must be the requested interval");
  const migration = parseMarker(answer.migration, "migration");
  const standalone = isStandalonePool(poolKey);
  if (standalone && migration !== null) {
    throw new ContractViolation("migration", "a standalone pool has no V2 migration");
  }
  if (source === "venue" && !standalone && migration?.venuePoolKey !== poolKey) {
    throw new ContractViolation("migration", "a venue pool's chart names the migration that recorded it");
  }
  if (source === "curve" && migration !== null && migration.curvePoolKey !== poolKey) {
    throw new ContractViolation("migration.curve_pool_key", "must be the requested curve");
  }
  const rows = answer.candles;
  if (!matchesSchema(listSchema.max(CANDLE_PAGE.max), rows)) throw new ContractViolation("candles", `must be a list of at most ${CANDLE_PAGE.max}`);
  const ms = INTERVAL_MS[interval];
  const candles = rows.map((row, index) => {
    const field = `candles[${index}]`;
    const candle = parseCandle(row, interval, field);
    if (migration !== null && source === "curve" && candle.bucketStart > migration.timestampMs) {
      throw new ContractViolation(`${field}.bucket_start`, "a curve candle starts no later than its migration");
    }
    if (migration !== null && source === "venue" && candle.bucketStart + ms <= migration.timestampMs) {
      throw new ContractViolation(`${field}.bucket_start`, "a venue candle ends after its migration");
    }
    return candle;
  });
  candles.slice(1).forEach((candle, index) => {
    const previous = candles[index];
    const field = `candles[${index + 1}]`;
    if (candle.bucketStart <= previous.bucketStart) throw new ContractViolation(`${field}.bucket_start`, "candles run oldest first");
    if (candle.open !== previous.close) throw new ContractViolation(`${field}.open`, "is the previous candle's close");
  });
  return { poolKey, source, venue, interval, candles, migration };
}

function parseVenueSwap(swap: unknown, venue: Venue, field: string): PoolTrade["venueSwap"] {
  if (swap === null) return null;
  const raw = record(swap, `${field}.venue_swap`);
  const at = (key: string) => `${field}.venue_swap.${key}`;
  if (!matchesSchema(z.boolean(), raw.a_to_b)) throw new ContractViolation(at("a_to_b"), "must be a boolean");
  const venueSwap = {
    amountIn: parseAtomic(raw.amount_in, at("amount_in"), 64),
    amountOut: parseAtomic(raw.amount_out, at("amount_out"), 64),
    refAmount: raw.ref_amount === null ? null : parseAtomic(raw.ref_amount, at("ref_amount"), 64),
    beforeSqrtPrice: parseAtomic(raw.before_sqrt_price, at("before_sqrt_price"), 128),
    afterSqrtPrice: parseAtomic(raw.after_sqrt_price, at("after_sqrt_price"), 128),
    aToB: raw.a_to_b,
  };
  if ((venue === "cetus") !== (venueSwap.refAmount !== null)) {
    throw new ContractViolation(at("ref_amount"), "only a Cetus swap has a referral amount");
  }
  return venueSwap;
}

function parseTrade(value: unknown, poolKey: string, venue: Venue, field: string): PoolTrade {
  const trade = record(value, field);
  if (trade.pool_key !== poolKey) throw new ContractViolation(`${field}.pool_key`, "must be the requested pool");
  if (trade.venue !== venue) throw new ContractViolation(`${field}.venue`, "must be the requested pool's venue");
  if (!matchesSchema(cursorSchema, trade.cursor)) throw new ContractViolation(`${field}.cursor`, "must be a cursor");
  if (!matchesSchema(digestSchema, trade.digest)) throw new ContractViolation(`${field}.digest`, "must be a digest");
  const trader = contractValue(traderSchema, trade.trader, `${field}.trader`, "must be an address or null");
  if (!matchesSchema(z.enum(["buy", "sell"]), trade.side)) throw new ContractViolation(`${field}.side`, "must be buy or sell");
  if (!matchesSchema(z.string(), trade.kind)) throw new ContractViolation(`${field}.kind`, "must be a trade kind");
  const swap = trade.venue_swap;
  if ((venue === "blast_curve") !== (trade.kind !== "swap") || (venue === "blast_curve") !== (swap === null)) {
    throw new ContractViolation(`${field}.kind`, "a venue pool's trades are swaps with their raw fields, a curve's never");
  }
  const venueSwap = parseVenueSwap(swap, venue, field);
  const inputs = trade.inputs as Record<string, unknown> | null;
  const decimals = typeof inputs?.quote_decimals === "string" ? inputs.quote_decimals : null;
  const supply = typeof inputs?.currency_supply === "string" ? inputs.currency_supply : null;
  const price = trade.price == null ? null : parsePriceString(trade.price, `${field}.price`);
  return {
    cursor: trade.cursor,
    timestampMs: parseCount(trade.timestamp_ms, `${field}.timestamp_ms`),
    digest: trade.digest,
    trader,
    ...(Array.isArray(trade.labels) && trade.labels.includes("whale") ? { whale: true as const } : {}),
    side: trade.side,
    kind: trade.kind,
    quoteAmount: parseAtomic(trade.quote_amount, `${field}.quote_amount`, 64),
    memeAmount: parseAtomic(trade.meme_amount, `${field}.meme_amount`, 64),
    price,
    volumeUsd: trade.volume_usd === null ? null : parseUsdString(trade.volume_usd, `${field}.volume_usd`),
    ...(venueSwap && {
      marketCapUsd: marketCapUsd(typeof trade.market_cap === "string" ? trade.market_cap : null, decimals, trade.usd),
      fdvUsd: quoteValueUsd(fdvInQuote(price, supply, decimals), trade.usd),
    }),
    venueSwap,
  };
}

/** A validated page of `poolKey`'s trades: its own, newest first. */
export function parsePoolTradesPage(poolKey: string, body: unknown): PoolTradesPage {
  const [venue] = splitKey(poolKey);
  const answer = record(body, "body");
  exactKeys(answer, ["trades"], "body", ["provenance", "archived_before"]);
  const rows = answer.trades;
  if (!matchesSchema(listSchema.max(TRADE_PAGE.max), rows)) throw new ContractViolation("trades", `must be a list of at most ${TRADE_PAGE.max}`);
  const trades = rows.map((row, index) => parseTrade(row, poolKey, venue, `trades[${index}]`));
  trades.slice(1).forEach((trade, index) => {
    if (compareEventCursors(trade.cursor, trades[index].cursor) >= 0) {
      throw new ContractViolation(`trades[${index + 1}].cursor`, "trades run newest first");
    }
  });
  return { poolKey, trades };
}

/** Reads one page of a pool's candles from blast-infra, validated, with its provenance. */
export function readPoolCandles(
  poolKey: string,
  request: CandleRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<PoolCandlePage>>> {
  return readV1("market", poolCandlesPath(poolKey, request), (body) => parsePoolCandlePage(poolKey, request.interval, body), dependencies);
}

/** Reads one page of a pool's trades (a venue pool's: its venue activity), validated. */
export function readPoolTrades(
  poolKey: string,
  request: TradeRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<PoolTradesPage>>> {
  return readV1("market", poolTradesPath(poolKey, request), (body) => parsePoolTradesPage(poolKey, body), dependencies);
}

/** A launch's recorded route: its curve, and the venue pool its migration recorded (null before). */
export type ChartRoute = Readonly<{ curvePoolKey: string; venuePoolKey: string | null }>;

/** A migrated launch's chart: two series that never merge, and the migration between them. */
export type MigratedChart = Readonly<{
  curve: Section<PoolCandlePage>;
  /** Null before migration, when the launch has no venue source. */
  venue: Section<PoolCandlePage> | null;
  migration: MigrationMarker | null;
}>;

function answered(read: RoutedRead<V1Answer<PoolCandlePage>>): RoutedRead<PoolCandlePage> {
  if (read.status === "unavailable") return read;
  if (read.data.kind === "refused") {
    return { status: "unavailable", provenance: { ...read.provenance, reason: `refused:${read.data.error.code}` } };
  }
  return { status: read.status, data: read.data.value, provenance: read.provenance };
}

function sameMarker(left: MigrationMarker | null, right: MigrationMarker | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.cursor === right.cursor &&
    left.timestampMs === right.timestampMs &&
    left.curvePoolKey === right.curvePoolKey &&
    left.venuePoolKey === right.venuePoolKey
  );
}

/**
 * Reads the curve's and the recorded venue pool's charts of one page
 * independently. A venue that cannot be read, or that answers about another
 * migration than the curve's, is unavailable on its own; the curve's chart
 * and the marker stay as read. A route whose curve is not a curve pool key, or
 * whose venue is not a Cetus or Bluefin pool key, is a CursorError.
 */
export async function readMigratedChart(
  route: ChartRoute,
  request: CandleRequest,
  dependencies: MarketDataDependencies,
): Promise<MigratedChart> {
  if (!matchesSchema(z.string().regex(CURVE_KEY), route.curvePoolKey)) throw new CursorError("curvePoolKey must be a blast_curve pool key");
  if (route.venuePoolKey !== null && !matchesSchema(z.string().regex(MIGRATOR_POOL_KEY), route.venuePoolKey)) {
    throw new CursorError("venuePoolKey must be a Cetus or Bluefin pool key");
  }
  const [curveRead, venueRead] = await Promise.all([
    readPoolCandles(route.curvePoolKey, request, dependencies).then(answered),
    route.venuePoolKey === null ? null : readPoolCandles(route.venuePoolKey, request, dependencies).then(answered),
  ]);
  const isEmpty = (page: PoolCandlePage) => page.candles.length === 0;
  const curve = sectionFromRead(curveRead, isEmpty);
  const curveMarker = curveRead.status === "unavailable" ? null : curveRead.data.migration;
  let venue = venueRead === null ? null : sectionFromRead(venueRead, isEmpty);
  const venueMarker = venueRead === null || venueRead.status === "unavailable" ? null : venueRead.data.migration;
  if (venue !== null && venueRead !== null && venueRead.status !== "unavailable") {
    const off = curveRead.status !== "unavailable" ? !sameMarker(curveMarker, venueMarker) : venueMarker?.curvePoolKey !== route.curvePoolKey;
    if (off) venue = { state: "unavailable", reason: "route-mismatch", provenance: venueRead.provenance };
  }
  const migration = curveMarker ?? (venue?.state === "unavailable" ? null : venueMarker);
  return { curve, venue, migration };
}
