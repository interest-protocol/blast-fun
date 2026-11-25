import { parseOpeningRound, type OpeningRound } from "@blast/core/modules/launchpad-contract/activity.ts";
import { ContractViolation, parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { EVENT_CURSOR, compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { deploymentMismatch, parseInfraProvenance, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import { CANDLE_INTERVALS, TRADE_PAGE, candleBucketStart, candleIntervalMs, comparePrices, parsePoolCandlePage, parsePoolTradesPage, type Candle, type CandleInterval, type MigrationMarker, type PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";

import type { StreamChartPage } from "./chart-client.ts";
import type { ChartRequest } from "./chart-model.ts";

type Envelope = Readonly<{ cursor: string; checkpoint: number; timestampMs: number; poolKey: string; provenance: Provenance }>;
export type ChartFrame = Envelope & (
  | Readonly<{ type: "trade"; trade: PoolTrade }>
  | Readonly<{ type: "candle_closed"; candle: Candle; interval: CandleInterval }>
  | Readonly<{ type: "lifecycle" }>
  | Readonly<{ type: "opening_round"; openingRound: OpeningRound }>
);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractViolation("frame", "must be an object");
  return value as Record<string, unknown>;
}

function wireMarker(marker: MigrationMarker | null) {
  return marker && { cursor: marker.cursor, timestamp_ms: marker.timestampMs, curve_pool_key: marker.curvePoolKey, venue_pool_key: marker.venuePoolKey };
}

/** Validate the complete pool/deployment envelope before a browser can use a frame. */
export function parseChartFrame(value: unknown, poolKey: string, expected: ExpectedDeployment | null, migration: MigrationMarker | null): ChartFrame {
  const frame = record(value);
  if (typeof frame.cursor !== "string" || !EVENT_CURSOR.test(frame.cursor)) throw new ContractViolation("cursor", "must be a numeric cursor");
  const checkpoint = parseCount(frame.checkpoint, "checkpoint");
  const provenance = parseInfraProvenance(frame.provenance);
  if (BigInt(frame.cursor.split(":")[0]) !== BigInt(checkpoint) || provenance.checkpoint !== checkpoint || deploymentMismatch(provenance, expected)) {
    throw new ContractViolation("provenance", "must match this frame and deployment");
  }
  const timestampMs = parseCount(frame.timestamp_ms, "timestamp_ms");
  if (provenance.timestampMs !== timestampMs) throw new ContractViolation("timestamp_ms", "must match its committed checkpoint");
  const envelope = { cursor: frame.cursor, checkpoint, provenance, timestampMs, poolKey };
  if (frame.type === "trade") {
    const trade = parsePoolTradesPage(poolKey, { trades: [frame.trade] }).trades[0];
    if (BigInt(trade.cursor.split(":")[0]) !== BigInt(checkpoint) || trade.timestampMs !== timestampMs) {
      throw new ContractViolation("trade", "must belong to the frame's checkpoint");
    }
    if (!["pre_share_buy", "buy", "sell", "opening_round", "opening_round_fill", "swap"].includes(trade.kind)) {
      throw new ContractViolation("trade.kind", "must be an indexed trade kind");
    }
    return { ...envelope, type: "trade", trade };
  }
  if (frame.pool_key !== poolKey) throw new ContractViolation("pool_key", "must be the subscribed pool");
  if (frame.type === "lifecycle") return { ...envelope, type: "lifecycle" };
  if (frame.type === "opening_round") return { ...envelope, type: "opening_round", openingRound: parseOpeningRound(frame.opening_round, "opening_round") };
  if (frame.type !== "candle_closed" || !CANDLE_INTERVALS.includes(frame.interval as CandleInterval) || frame.interval === "1s") {
    throw new ContractViolation("type", "must be a supported pool log frame");
  }
  const interval = frame.interval as CandleInterval;
  const page = parsePoolCandlePage(poolKey, interval, { interval, candles: [frame.candle], migration: wireMarker(migration) });
  if (page.candles[0].bucketStart + candleIntervalMs(interval) > timestampMs) throw new ContractViolation("candle", "must be closed at this checkpoint");
  return { ...envelope, type: "candle_closed", interval, candle: page.candles[0] };
}

/** A missing anchor or discontinuity needs durable history, never an invented candle. */
export class ChartBackfillRequired extends Error {}

export function sameChartMigration(left: MigrationMarker, right: MigrationMarker | null): boolean {
  return right !== null && left.cursor === right.cursor && left.timestampMs === right.timestampMs && left.curvePoolKey === right.curvePoolKey && left.venuePoolKey === right.venuePoolKey;
}

function sumUsd(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  const atoms = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(18, "0"));
  };
  const sum = (atoms(left) + atoms(right)).toString().padStart(19, "0");
  const fraction = sum.slice(-18).replace(/0+$/, "");
  return sum.slice(0, -18) + (fraction ? `.${fraction}` : "");
}

function closeCandle(candles: Candle[], candle: Candle, request: ChartRequest): void {
  const at = candles.findIndex((item) => item.bucketStart === candle.bucketStart);
  if (at >= 0) candles[at] = candle;
  else if (!candles.length || candle.bucketStart > candles.at(-1)!.bucketStart) candles.push(candle);
  else if (request.from === undefined || candle.bucketStart >= request.from) throw new ChartBackfillRequired("closed candle is missing from the loaded history");
}

function tradedCandle(previous: Candle | undefined, trade: PoolTrade & { price: string }, bucketStart: number): Candle {
  const active = previous?.bucketStart === bucketStart ? previous : null;
  const open = active?.open ?? previous?.close ?? trade.price;
  const base = active ?? { bucketStart, open, high: open, low: open, close: open, volumeQuote: 0n, volumeMeme: 0n, volumeUsd: null, buys: 0, sells: 0, trades: 0 };
  return {
    ...base, close: trade.price,
    high: comparePrices(trade.price, base.high) > 0 ? trade.price : base.high,
    low: comparePrices(trade.price, base.low) < 0 ? trade.price : base.low,
    volumeQuote: base.volumeQuote + trade.quoteAmount,
    volumeMeme: base.volumeMeme + trade.memeAmount,
    volumeUsd: sumUsd(base.volumeUsd, trade.volumeUsd),
    buys: base.buys + (trade.side === "buy" ? 1 : 0),
    sells: base.sells + (trade.side === "sell" ? 1 : 0),
    trades: base.trades + 1,
  };
}

function addTrade(candles: Candle[], trade: PoolTrade, interval: CandleInterval, request: ChartRequest): void {
  if (trade.kind === "opening_round_fill" || trade.price === null) return;
  const bucketStart = candleBucketStart(interval, trade.timestampMs);
  if (request.from !== undefined && bucketStart < request.from) return;
  const previous = candles.at(-1);
  if (previous && bucketStart < previous.bucketStart) throw new ChartBackfillRequired("trade precedes the loaded head");
  if (!previous && request.from !== undefined) throw new ChartBackfillRequired("bounded empty history has no previous-close anchor");
  const candle = tradedCandle(previous, { ...trade, price: trade.price }, bucketStart);
  if (previous?.bucketStart === bucketStart) candles[candles.length - 1] = candle;
  else candles.push(candle);
}

export function candlesFromTrades(trades: readonly PoolTrade[]): Candle[] {
  const candles: Candle[] = [];
  for (const trade of trades) addTrade(candles, trade, "1s", { interval: "1s", capped: false });
  return candles;
}

/** A Live trace point. A null price ends the trace until the next priced execution. */
export type LivePricePoint = Readonly<{ timestampMs: number; price: string | null }>;

/**
 * Live's price over `[from, through]`, drawn as steps: the last execution
 * before `from` opens the window, each later execution changes the price, and
 * the last price holds to `through`, the end of confirmed coverage. An
 * execution without a price breaks the trace. `executions` is the newest
 * contiguous tape, oldest first, without opening-round fills.
 */
export function liveTrace(executions: readonly PoolTrade[], from: number, through: number): LivePricePoint[] {
  if (through < from) return [];
  const before = executions.findLast(({ timestampMs }) => timestampMs < from);
  const points: LivePricePoint[] = before && before.price !== null ? [{ timestampMs: from, price: before.price }] : [];
  for (const { timestampMs, price } of executions) {
    if (timestampMs >= from && timestampMs <= through) points.push(...traceStep(points.at(-1), timestampMs, price));
  }
  const last = points.at(-1);
  return last?.price != null && last.timestampMs < through ? [...points, { timestampMs: through, price: last.price }] : points;
}

/** A priced execution moves the trace; an unpriced one holds the price up to it, then breaks. */
function traceStep(held: LivePricePoint | undefined, timestampMs: number, price: string | null): LivePricePoint[] {
  if (price !== null) return [{ timestampMs, price }];
  if (held?.price == null) return [];
  const hold = held.timestampMs < timestampMs - 0.5 ? [{ timestampMs: timestampMs - 0.5, price: held.price }] : [];
  return [...hold, { timestampMs, price: null }];
}

function applyLiveTrade(page: StreamChartPage, tape: readonly PoolTrade[], trade: PoolTrade, request: ChartRequest): StreamChartPage {
  const last = tape.at(-1);
  if (last && compareEventCursors(trade.cursor, last.cursor) <= 0) {
    if (tape.some(({ cursor }) => cursor === trade.cursor)) return page;
    throw new ChartBackfillRequired("trade precedes the loaded tape");
  }
  const liveTrades = [...tape, trade].slice(-TRADE_PAGE.max);
  const candles = [...page.candles];
  addTrade(candles, trade, page.interval, request);
  // Rebuild the bounded tape when its first trade rolls out, since its bucket may have retained trades.
  const nextCandles = liveTrades[0] === tape[0] || !last ? candles : candlesFromTrades(liveTrades);
  return { ...page, liveTrades, candles: nextCandles, truncated: page.truncated || liveTrades.length === TRADE_PAGE.max };
}

/** Apply ordered, previously unseen frames after the HTTP checkpoint fence. No gap filling. */
export function applyChartFrame(page: StreamChartPage, frame: ChartFrame, request: ChartRequest): StreamChartPage {
  if (frame.poolKey !== page.poolKey || page.interval !== request.interval) throw new ChartBackfillRequired("route changed");
  if (frame.type === "lifecycle") throw new ChartBackfillRequired("lifecycle changed");
  // A round's state is not a candle; the stream hands it to the coin page instead.
  if (frame.type === "opening_round") return page;
  const migration = page.migration;
  if (frame.type === "trade" && migration && (page.source === "curve" ? compareEventCursors(frame.trade.cursor, migration.cursor) >= 0 : compareEventCursors(frame.trade.cursor, migration.cursor) <= 0)) {
    throw new ChartBackfillRequired("trade crosses the committed migration");
  }
  if (page.liveTrades && frame.type === "trade") return applyLiveTrade(page, page.liveTrades, frame.trade, request);
  const candles = [...page.candles];
  if (frame.type === "candle_closed") {
    if (frame.interval !== page.interval) return page;
    closeCandle(candles, frame.candle, request);
  } else addTrade(candles, frame.trade, page.interval, request);
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].open !== candles[index - 1].close) throw new ChartBackfillRequired("authoritative close changed the next open");
  }
  return { ...page, candles: candles.filter((candle) => request.from === undefined || candle.bucketStart >= request.from).slice(-(request.limit ?? 2000)) };
}
