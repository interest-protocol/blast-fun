import { EVENT_CURSOR, compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { displayPriceCoinSchema, displayPriceFrameSchema, MARKET_STREAM_BUDGET, MARKET_STREAM_PATH, type DisplayPriceFrame } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { deploymentMismatch, parseInfraProvenance, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { MigrationMarker, PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { normalizeStructTag } from "@mysten/sui/utils";

import { parseChartFrame, type ChartFrame } from "./chart/chart-live-model.ts";
import { publishChartRound } from "./chart/chart-live-round.ts";
import { gatedEventSource } from "#web/lib/live-stream/gated-event-source.ts";
import { beginMarketHints } from "#web/lib/live-stream/market-hints.ts";
import { browserSocket, fetchLiveTicket, liveBucket, liveMarketSource, liveSourceState } from "#web/lib/live-stream/live-socket-source.ts";
import { presaleMarketFrameSchema, type PresaleMarketFrame } from "@blast/core/modules/live/presale-market-frames.ts";

/**
 * A subscription's view of the tab's market stream. `live`: every pool of the connection has its
 * fence and the hint handshake arrived. `unavailable`: the connection serves other pools (at most
 * two per tab), or the stream never served one of its pools, so this subscription stays on its polls.
 * Every state but `live` voids its fences.
 */
export type MarketStreamState = "connecting" | "live" | "reconnecting" | "paused" | "unavailable";

/** A pool trade as its frame carried it. `summary` is the frame's pool summary, not validated here. */
export type MarketTrade = Readonly<{ poolKey: string; checkpoint: number; trade: PoolTrade; summary: unknown }>;

export type MarketStreamListener = Readonly<{
  state: (state: MarketStreamState) => void;
  /** The pool is live from this checkpoint: every later frame follows, in cursor order, once. */
  fence?: (poolKey: string, checkpoint: number, priceMissing?: true) => void;
  /** Every validated frame after the fence; only for subscriptions that name a `migration`. */
  frame?: (frame: ChartFrame, chars: number) => void;
  trade?: (trade: MarketTrade) => void;
  prices?: (frame: DisplayPriceFrame) => void;
  presale?: (frame: PresaleMarketFrame) => void;
  presaleReady?: (checkpoint: number | null) => void;
}>;

export type MarketStreamRequest = Readonly<{
  pools: readonly string[];
  priceCoins?: readonly string[];
  presale?: string;
  expected: ExpectedDeployment | null;
  /** Candle frames are checked against the migration that bounds the chart; omit it for trades only. */
  migration?: () => MigrationMarker | null;
  /** The coin these pools trade, so screens that watch the coin can follow the stream without joining it. */
  coin?: string;
  listener: MarketStreamListener;
}>;

/**
 * A screen that follows one coin's trades without asking for a stream. `live`: the tab's stream is live
 * on a pool of this coin, so a quiet market is known to be quiet. It never changes which pools stream.
 */
export type CoinTradeListener = Readonly<{
  live: (live: boolean) => void;
  trade: (trade: MarketTrade) => void;
}>;

export type MarketStreamSubscription = Readonly<{
  /** Drops the connection and reconnects with backoff: a subscriber found the stream unusable. */
  restart: () => void;
  stop: () => void;
}>;

export interface MarketEventSource {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}

export type MarketStreamDependencies = Readonly<{
  createSource: (url: string) => MarketEventSource;
  schedule: (run: () => void, ms: number) => () => void;
  /** Runs after the current task's other subscription changes, so they reconnect once. */
  defer: (run: () => void) => void;
  random: () => number;
  visible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
}>;

/** `unserved`: the stream never fenced one of its pools, so it stays on its polls until the next retry or a new subscription. */
type Subscriber = { request: MarketStreamRequest; state: MarketStreamState | null; unserved: boolean };
type Observer = { coin: string; listener: CoinTradeListener; live: boolean | null };
/** `coin` survives reconnects: it names the pool, not the connection's progress through it. */
type Pool = { fence: number | null; seen: number; cursor: string | null; tradeCursor: string | null; summary: unknown; coin: string | null; priceMissing?: boolean };
type Connection = { pools: Map<string, Pool>; priceCoins: Set<string>; presale?: string; presaleFence: number | null; presaleSeen: number; expected: ExpectedDeployment | null; source: MarketEventSource | null; live: boolean };

const HELLO_DEADLINE_MS = 10_000;
const LEGACY_HEARTBEAT_TIMEOUT_MS = 45_000;
/** A hidden tab keeps its stream this long, so a quick tab flip costs no reconnect or history read. */
export const HIDDEN_GRACE_MS = 15_000;
/** A connection live this long resets the backoff; a subscriber that keeps restarting a live stream still backs off. */
export const STABLE_MS = 20_000;
/**
 * Unserved pools are tried again after this, doubling to UNSERVED_RETRY_MAX_MS (plus up to half again): a coin the
 * engine starts indexing, or an engine back from a restart, streams again. A probe waits while a live stream serves
 * other pools in a visible tab, so it never resets them.
 */
export const UNSERVED_RETRY_MS = 60_000;
export const UNSERVED_RETRY_MAX_MS = 900_000;

/** A coin type in one spelling, or null when it is not one. */
export function coinKey(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeStructTag(value);
  } catch {
    return null;
  }
}

function sameExpected(left: ExpectedDeployment | null, right: ExpectedDeployment | null): boolean {
  return left?.network === right?.network && left?.deployment === right?.deployment;
}

function fitsExpected(request: MarketStreamRequest, expected: ExpectedDeployment | null): boolean {
  return (!request.pools.length && request.expected === null) || sameExpected(request.expected, expected);
}

/** A round's state is whole at its checkpoint: no candle history, order or refetch depends on it. */
function round(frame: ChartFrame): void {
  if (frame.type === "opening_round") publishChartRound({ poolKey: frame.poolKey, openingRound: frame.openingRound, provenance: frame.provenance });
}

/** Advances the pool past `frame`; false when the stream already delivered it. */
function fresh(pool: Pool, frame: ChartFrame, summary: unknown): boolean {
  pool.seen = Math.max(pool.seen, frame.checkpoint);
  if (pool.cursor && compareEventCursors(frame.cursor, pool.cursor) <= 0) return false;
  pool.cursor = frame.cursor;
  if (frame.type !== "trade") return true;
  if (pool.tradeCursor && compareEventCursors(frame.trade.cursor, pool.tradeCursor) <= 0) return false;
  pool.tradeCursor = frame.trade.cursor;
  pool.summary = summary ?? null;
  if (frame.trade.kind !== "opening_round_fill") pool.priceMissing = frame.trade.price === null;
  return true;
}

/** One bounded market stream per tab: at most two pools, shared by every screen that watches them. */
export class MarketStreamHub {
  private readonly deps: MarketStreamDependencies;
  private readonly subscribers: Subscriber[] = [];
  private readonly observers = new Set<Observer>();
  private connection: Connection | null = null;
  private hints: ReturnType<typeof beginMarketHints> | null = null;
  private attempts = 0;
  /** The stream was refused even after a gate refresh: no source and no timer until the tab returns or the pools change. */
  private refused = false;
  private reconciling = false;
  private cancelHeartbeat: (() => void) | null = null;
  private cancelHello: (() => void) | null = null;
  private cancelReconnect: (() => void) | null = null;
  private cancelHidden: (() => void) | null = null;
  private cancelStable: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private retries = 0;
  private stopVisibility: (() => void) | null = null;

  constructor(deps: MarketStreamDependencies) {
    this.deps = deps;
  }

  subscribe(request: MarketStreamRequest): MarketStreamSubscription {
    const { pools, priceCoins = [], presale } = request;
    if ((!pools.length && !priceCoins.length && presale === undefined) ||
      (presale !== undefined && !SUI_OBJECT_ID_PATTERN.test(presale)) ||
      pools.length > MARKET_STREAM_BUDGET.maxPoolsPerClient || new Set(pools).size !== pools.length || pools.some((pool) => !POOL_KEY.test(pool)) ||
      priceCoins.length > MARKET_STREAM_BUDGET.maxPriceCoinsPerClient || new Set(priceCoins).size !== priceCoins.length ||
      priceCoins.some((coin) => !displayPriceCoinSchema.safeParse(coin).success)) {
      throw new Error("Invalid subscription to market pools or coin prices.");
    }
    const subscriber: Subscriber = { request, state: null, unserved: false };
    this.subscribers.unshift(subscriber);
    this.stopVisibility ??= this.deps.onVisibilityChange(() => this.visibility());
    if (this.connection) {
      this.queueReconcile();
      // A later subscriber to a live pool starts from what the stream already delivered.
      this.deps.defer(() => this.replay(subscriber));
    } else this.reconcile();
    return {
      restart: () => { if (this.subscribers.includes(subscriber) && !subscriber.unserved) this.reconnect(); },
      stop: () => {
        const index = this.subscribers.indexOf(subscriber);
        if (index < 0) return;
        subscriber.unserved = true;
        this.subscribers.splice(index, 1);
        this.queueReconcile();
      },
    };
  }

  /** Follows `coinType`'s trades on whatever the tab already streams; it never opens or widens a stream. */
  observe(coinType: string, listener: CoinTradeListener): () => void {
    const coin = coinKey(coinType);
    // A malformed coin type never streams: its screens stay on their polls.
    if (!coin) return () => {};
    const observer: Observer = { coin, listener, live: null };
    this.observers.add(observer);
    this.observed();
    return () => {
      this.observers.delete(observer);
    };
  }

  /** The latest pool summary a trade frame carried on this connection, unvalidated. */
  summary(poolKey: string): unknown {
    return this.connection?.pools.get(poolKey)?.summary ?? null;
  }

  private queueReconcile(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    this.deps.defer(() => {
      this.reconciling = false;
      this.reconcile();
    });
  }

  /** Newest subscribers first: whole subscriptions while the union fits one stream. */
  private wanted(): { pools: string[]; priceCoins: Set<string>; presale?: string; expected: ExpectedDeployment | null } {
    const pools: string[] = [];
    let priceCoins = new Set<string>();
    const served = this.subscribers.filter((subscriber) => !subscriber.unserved);
    const presale = served.find(({ request }) => request.presale !== undefined)?.request.presale;
    const expected = served.find(({ request }) => request.pools.length > 0 || request.expected !== null)?.request.expected ?? null;
    for (const { request } of served) {
      if (!fitsExpected(request, expected)) continue;
      const poolUnion = [...new Set([...pools, ...request.pools])];
      const priceUnion = new Set([...priceCoins, ...request.priceCoins ?? []]);
      if (poolUnion.length > MARKET_STREAM_BUDGET.maxPoolsPerClient ||
        priceUnion.size > MARKET_STREAM_BUDGET.maxPriceCoinsPerClient) continue;
      pools.splice(0, pools.length, ...poolUnion);
      priceCoins = priceUnion;
    }
    return { pools, priceCoins, presale, expected };
  }

  /** Each pool's coin, as its subscribers name it. */
  private nameCoins(connection: Connection): void {
    for (const { request } of this.subscribers) {
      const coin = coinKey(request.coin);
      const pools = coin ? request.pools.map((key) => connection.pools.get(key)) : [];
      for (const pool of pools) if (pool) pool.coin = coin;
    }
  }

  private covers(subscriber: Subscriber): boolean {
    const connection = this.connection;
    const { request } = subscriber;
    return connection !== null && !subscriber.unserved && fitsExpected(request, connection.expected) &&
      (request.presale === undefined || request.presale === connection.presale) &&
      request.pools.every((pool) => connection.pools.has(pool)) &&
      (request.priceCoins ?? []).every((coin) => connection.priceCoins.has(coin));
  }

  private reconcile(): void {
    const wanted = this.wanted();
    if (!wanted.pools.length && !wanted.priceCoins.size && !wanted.presale) return this.close();
    const current = this.connection;
    const same = current !== null && sameExpected(current.expected, wanted.expected) &&
      current.presale === wanted.presale &&
      current.pools.size === wanted.pools.length && wanted.pools.every((pool) => current.pools.has(pool)) &&
      current.priceCoins.size === wanted.priceCoins.size && [...wanted.priceCoins].every((coin) => current.priceCoins.has(coin));
    if (!same) {
      this.drop();
      this.connection = { pools: new Map(wanted.pools.map((pool) => [pool, { fence: null, seen: 0, cursor: null, tradeCursor: null, summary: null, coin: current?.pools.get(pool)?.coin ?? null }])), priceCoins: wanted.priceCoins, presale: wanted.presale, presaleFence: null, presaleSeen: 0, expected: wanted.expected, source: null, live: false };
      this.attempts = 0;
    }
    this.nameCoins(this.connection!);
    for (const subscriber of this.subscribers) {
      if (!this.covers(subscriber)) this.tell(subscriber, "unavailable");
      // A replaced connection voids every fence, even for a subscriber that was already connecting.
      else if (!same) this.tell(subscriber, this.deps.visible() ? "connecting" : "paused", true);
    }
    this.observed();
    if (same) return;
    // The new pools need a new hint handshake. The new carrier replaces the old in one step, so hint
    // clients keep waiting for it (even while hidden) rather than open the legacy stream.
    this.hints = beginMarketHints();
    if (this.deps.visible()) this.connect();
  }

  private replay(subscriber: Subscriber): void {
    const connection = this.connection;
    if (!connection || !this.subscribers.includes(subscriber) || !this.covers(subscriber) || subscriber.state !== null) return;
    if (!connection.source) {
      if (this.refused) return this.tell(subscriber, "unavailable");
      return this.tell(subscriber, this.deps.visible() ? "connecting" : "paused");
    }
    this.tell(subscriber, connection.live ? "live" : "connecting");
    if (subscriber.request.presale && connection.presaleFence !== null)
      subscriber.request.listener.presaleReady?.(Math.max(connection.presaleFence, connection.presaleSeen));
    for (const key of subscriber.request.pools) {
      const pool = connection.pools.get(key)!;
      if (pool.fence !== null) this.notifyFence(subscriber, key, pool);
    }
  }

  private notifyFence(subscriber: Subscriber, key: string, pool: Pool): void {
    const checkpoint = Math.max(pool.fence ?? 0, pool.seen);
    if (pool.priceMissing) subscriber.request.listener.fence?.(key, checkpoint, true);
    else subscriber.request.listener.fence?.(key, checkpoint);
  }

  private tell(subscriber: Subscriber, state: MarketStreamState, force = false): void {
    if (subscriber.state === state && !force) return;
    subscriber.state = state;
    subscriber.request.listener.state(state);
  }

  private covered(state: MarketStreamState): void {
    for (const subscriber of [...this.subscribers]) if (this.covers(subscriber)) this.tell(subscriber, state);
    this.observed();
  }

  private presaleState(connection: Connection, checkpoint: number | null): void {
    if (connection.presaleFence === checkpoint) return;
    connection.presaleFence = checkpoint;
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.request.presale && this.covers(subscriber)) subscriber.request.listener.presaleReady?.(checkpoint);
    }
  }

  private streams(coin: string): boolean {
    const connection = this.connection;
    return connection !== null && connection.live && [...connection.pools.values()].some((pool) => pool.coin === coin);
  }

  /** Tells each observer whose coin's coverage changed. */
  private observed(): void {
    for (const observer of [...this.observers]) {
      const live = this.streams(observer.coin);
      if (observer.live === live || !this.observers.has(observer)) continue;
      observer.live = live;
      observer.listener.live(live);
    }
  }

  private visibility(): void {
    if (this.deps.visible()) {
      this.cancelHidden?.();
      this.cancelHidden = null;
      if (this.connection && !this.connection.source && !this.cancelReconnect) {
        this.attempts = 0;
        this.hints ??= beginMarketHints();
        this.connect();
      }
    } else if (this.connection?.source && !this.cancelHidden) {
      if (!this.connection.pools.size) return this.pause();
      this.cancelHidden = this.deps.schedule(() => {
        this.cancelHidden = null;
        this.pause();
      }, HIDDEN_GRACE_MS);
    }
  }

  private pause(): void {
    if (!this.connection) return;
    this.drop();
    // Hint clients wait for the hello that follows the tab's return, not for the legacy stream.
    this.hints?.waiting();
    this.covered("paused");
  }

  private close(): void {
    if (!this.subscribers.length) {
      this.cancelRetry?.();
      this.cancelRetry = null;
      this.retries = 0;
    }
    this.drop();
    this.connection = null;
    this.hints?.stop();
    this.hints = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    this.observed();
  }

  /** Ends the current EventSource and every timer that belongs to it; pools lose their fences. */
  private drop(): void {
    const connection = this.connection;
    this.refused = false;
    this.cancelHello?.();
    this.cancelHello = null;
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.cancelHidden?.();
    this.cancelHidden = null;
    this.cancelStable?.();
    this.cancelStable = null;
    if (!connection) return;
    connection.source?.close();
    connection.source = null;
    connection.live = false;
    this.presaleState(connection, null);
    connection.presaleSeen = 0;
    for (const pool of connection.pools.values()) Object.assign(pool, { fence: null, seen: 0, cursor: null, tradeCursor: null, summary: null });
    this.observed();
  }

  private connect(): void {
    const connection = this.connection;
    if (!connection) return;
    const params = new URLSearchParams();
    params.set("activity", "true");
    for (const key of connection.pools.keys()) params.append("pool", key);
    for (const coin of connection.priceCoins) params.append("price_coin", coin);
    if (connection.presale) params.set("presale", connection.presale);
    this.refused = false;
    const source = this.deps.createSource(`${MARKET_STREAM_PATH}?${params}`);
    connection.source = source;
    this.covered("connecting");
    const current = () => this.connection === connection && connection.source === source;
    let hintReady = false;
    this.cancelHello = this.deps.schedule(() => { if (current()) this.reconnect(); }, HELLO_DEADLINE_MS);
    const ready = () => {
      if (connection.live || !hintReady || [...connection.pools.values()].some((pool) => pool.fence === null)) return;
      this.cancelHello?.();
      this.cancelHello = null;
      connection.live = true;
      if (!this.subscribers.some((subscriber) => subscriber.unserved)) this.retries = 0;
      this.cancelStable = this.deps.schedule(() => {
        this.cancelStable = null;
        this.attempts = 0;
      }, STABLE_MS);
      this.covered("live");
    };
    let heartbeatTimeoutMs: number | null = null;
    const expectHeartbeat = () => {
      if (!current() || heartbeatTimeoutMs === null) return;
      this.cancelHeartbeat?.();
      this.cancelHeartbeat = this.deps.schedule(() => {
        if (current()) this.reconnect();
      }, heartbeatTimeoutMs);
    };
    const confirmPong = (checkpoint: unknown) => {
      // The handshake pong is the first confirmed upstream heartbeat.
      if (heartbeatTimeoutMs === MARKET_STREAM_BUDGET.heartbeatTimeoutMs) expectHeartbeat();
      if (typeof checkpoint === "number" && Number.isSafeInteger(checkpoint) && checkpoint >= 0) {
        this.presaleState(connection, checkpoint);
      }
    };
    source.addEventListener("heartbeat", expectHeartbeat);
    source.addEventListener("status", (event) => {
      if (!current()) return;
      try {
        const status = JSON.parse(event.data ?? "") as Record<string, unknown>;
        if (status.state !== "live") {
          // The relay names the one pool it could not serve; every other pool keeps streaming.
          if (status.state === "unavailable" && hintReady && connection.pools.has(String(status.pool_key))) this.unserve([String(status.pool_key)]);
          else if (status.state === "unavailable" || status.state === "reconnecting" || status.state === "resyncing") this.reconnect();
          return;
        }
        const key = String(status.pool_key);
        const pool = connection.pools.get(key);
        const provenance = parseInfraProvenance(status.provenance);
        if (!pool || !Number.isSafeInteger(status.checkpoint) || Number(status.checkpoint) < 0 || provenance.checkpoint !== status.checkpoint || deploymentMismatch(provenance, connection.expected) || typeof status.cursor !== "string" || !EVENT_CURSOR.test(status.cursor)) throw new Error("Invalid subscription fence");
        if (BigInt(status.cursor.split(":")[0]) > BigInt(Number(status.checkpoint))) throw new Error("Cursor exceeds its fence");
        Object.assign(pool, { fence: Number(status.checkpoint), seen: Number(status.checkpoint), cursor: null, tradeCursor: null, priceMissing: status.price_missing === true });
        for (const subscriber of [...this.subscribers]) {
          if (current() && this.covers(subscriber) && subscriber.request.pools.includes(key)) this.notifyFence(subscriber, key, pool);
        }
        ready();
      } catch {
        // A listener may already have replaced this connection (a pool it unserved).
        if (current()) this.reconnect();
      }
    });
    source.addEventListener("market", (event) => {
      if (!current()) return;
      try {
        this.market(connection, event.data ?? "");
      } catch {
        this.reconnect();
      }
    });
    source.addEventListener("prices", (event) => {
      if (!current() || !event.data || event.data.length > MARKET_STREAM_BUDGET.maxChunkBytes) return;
      let frame: DisplayPriceFrame;
      try {
        frame = displayPriceFrameSchema.parse(JSON.parse(event.data));
      } catch {
        return;
      }
      for (const subscriber of [...this.subscribers]) {
        const { priceCoins, listener } = subscriber.request;
        if (!priceCoins?.length || !listener.prices || !this.covers(subscriber) || !current()) continue;
        const requested = new Set(priceCoins);
        const prices = frame.prices.filter((price) => requested.has(price.coin_type));
        if (prices.length) listener.prices({ ...frame, prices });
      }
    });
    source.addEventListener("resync", () => { if (current()) this.reconnect(); });
    source.addEventListener("presale", (event) => {
      if (!current() || connection.presaleFence === null || !connection.presale || !event.data || event.data.length > MARKET_STREAM_BUDGET.maxChunkBytes) return;
      let frame: PresaleMarketFrame;
      try {
        frame = presaleMarketFrameSchema.parse(JSON.parse(event.data));
      } catch {
        return;
      }
      if (frame.presale_id !== connection.presale) return;
      connection.presaleSeen = Math.max(connection.presaleSeen, Number(frame.cursor.split(":", 1)[0]));
      for (const subscriber of [...this.subscribers]) {
        if (current() && this.covers(subscriber) && subscriber.request.presale === frame.presale_id) {
          subscriber.request.listener.presale?.(frame);
        }
      }
    });
    // A drop after the stream opened: not live, retried with backoff.
    source.addEventListener("error", () => { if (current()) this.reconnect(); });
    // Refused before it opened even after one gate refresh (a refused cookie, or any non-200 open such as
    // `503 Market streaming is busy`): polls carry the page until the tab returns or the wanted pools change.
    source.addEventListener("refused", () => {
      if (!current()) return;
      this.hints?.disconnected();
      this.drop();
      this.refused = true;
      this.covered("unavailable");
    });
    source.addEventListener("hint", (event) => {
      if (!current() || !event.data) return;
      try {
        const hint = JSON.parse(event.data) as Record<string, unknown>;
        if (hint.type === "hello" && parseInfraProvenance(hint.provenance).network === "mainnet" && !hintReady) {
          hintReady = true;
          if (hint.heartbeat === true) {
            heartbeatTimeoutMs = hint.heartbeat_ms === MARKET_STREAM_BUDGET.heartbeatMs
              ? MARKET_STREAM_BUDGET.heartbeatTimeoutMs
              : LEGACY_HEARTBEAT_TIMEOUT_MS;
            expectHeartbeat();
          }
          // Pools get their fence deadline from the handshake, not from a slow upstream before it.
          this.cancelHello?.();
          this.cancelHello = this.deps.schedule(() => { if (current()) this.deadline(connection); }, HELLO_DEADLINE_MS);
          ready();
        } else if (hintReady && hint.type === "pong") {
          confirmPong(hint.presale_checkpoint);
        }
      } catch { /* The hint carrier refuses malformed hints independently. */ }
      this.hints?.frame(event.data);
    });
  }

  private market(connection: Connection, data: string): void {
    if (data.length > MARKET_STREAM_BUDGET.maxUpstreamFrameChars) throw new Error("Oversized market frame");
    const wire = JSON.parse(data) as Record<string, unknown>;
    const key = String(wire.pool_key ?? (wire.trade as Record<string, unknown> | undefined)?.pool_key);
    const pool = connection.pools.get(key);
    if (!pool || pool.fence === null) throw new Error("Frame before its subscription fence");
    if (wire.type === "opening_round") return round(parseChartFrame(wire, key, connection.expected, null));
    const subscribers = this.subscribers.filter((subscriber) => this.covers(subscriber) && subscriber.request.pools.includes(key));
    const charts = subscribers.filter((subscriber) => subscriber.request.migration);
    // Trades and lifecycles never read the migration; a candle is checked against each chart's.
    const shared = wire.type === "candle_closed" ? null : parseChartFrame(wire, key, connection.expected, null);
    const frames = charts.map((subscriber) => [subscriber, shared ?? parseChartFrame(wire, key, connection.expected, subscriber.request.migration!())] as const);
    const frame = shared ?? frames[0]?.[1];
    if (!frame) {
      if (typeof wire.cursor === "string" && EVENT_CURSOR.test(wire.cursor)) pool.seen = Math.max(pool.seen, Number(wire.cursor.split(":")[0]));
      return;
    }
    if (!fresh(pool, frame, wire.summary)) return;
    // A listener may restart or stop the stream: later listeners then get nothing from this frame.
    const current = (subscriber: Subscriber) => this.connection === connection && connection.source !== null && this.subscribers.includes(subscriber);
    for (const [subscriber, parsed] of frames) if (current(subscriber)) subscriber.request.listener.frame?.(parsed, data.length);
    if (frame.type !== "trade") return;
    const trade: MarketTrade = { poolKey: key, checkpoint: frame.checkpoint, trade: frame.trade, summary: pool.summary };
    for (const subscriber of subscribers.filter(current)) subscriber.request.listener.trade?.(trade);
    this.toObservers(connection, pool, trade);
  }

  /** Hands a trade to the observers of its pool's coin, while `connection` is still the stream. */
  private toObservers(connection: Connection, pool: Pool, trade: MarketTrade): void {
    const current = () => this.connection === connection && connection.source !== null;
    if (!current()) return;
    if (pool.coin === null) {
      // A pool whose subscriber named no coin learns it from its first trade.
      pool.coin = coinKey((pool.summary as { coin?: unknown } | null)?.coin);
      this.observed();
    }
    for (const observer of [...this.observers]) {
      if (observer.coin === pool.coin && this.observers.has(observer) && current()) observer.listener.trade(trade);
    }
  }

  /** After the hint handshake, a pool still without its fence is one the stream does not serve. */
  private deadline(connection: Connection): void {
    const unfenced = [...connection.pools].filter(([, pool]) => pool.fence === null).map(([key]) => key);
    if (unfenced.length) this.unserve(unfenced);
    else this.reconnect();
  }

  /** Subscribers of these pools stay on their polls; the others keep (or reopen) the stream without them. */
  private unserve(keys: readonly string[]): void {
    const unfenced = new Set(keys);
    for (const subscriber of [...this.subscribers]) {
      if (!subscriber.request.pools.some((key) => unfenced.has(key))) continue;
      subscriber.unserved = true;
      this.tell(subscriber, "unavailable");
    }
    if (!this.cancelRetry) this.retryUnserved();
    this.reconcile();
  }

  private retryUnserved(): void {
    const delay = Math.round(Math.min(UNSERVED_RETRY_MAX_MS, UNSERVED_RETRY_MS * 2 ** this.retries) * (1 + this.deps.random() / 2));
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null;
      if (!this.subscribers.some((subscriber) => subscriber.unserved)) return;
      // A probe would restart the stream that serves other pools, or delay it on the tab's return: it waits.
      if (this.connection?.live || !this.deps.visible()) return this.retryUnserved();
      this.retries++;
      for (const subscriber of this.subscribers) subscriber.unserved = false;
      // Every subscriber unserved closed the hub, visibility listener included.
      this.stopVisibility ??= this.deps.onVisibilityChange(() => this.visibility());
      this.reconcile();
    }, delay);
  }

  private reconnect(): void {
    const connection = this.connection;
    if (!connection?.source) return;
    this.hints?.disconnected();
    this.drop();
    this.covered("reconnecting");
    const delay = Math.round(Math.min(30_000, 500 * 2 ** Math.min(this.attempts++, 6)) * (1 + this.deps.random() / 2));
    this.cancelReconnect = this.deps.schedule(() => {
      this.cancelReconnect = null;
      if (this.connection !== connection) return;
      if (!this.deps.visible()) return this.pause();
      this.connect();
    }, delay);
  }
}

let tab: MarketStreamHub | null = null;

function eventSource(url: string): MarketEventSource {
  const events = gatedEventSource(url);
  return {
    addEventListener: (type, receive) => events.addEventListener(type, (event) => receive("data" in event ? { data: String(event.data) } : {})),
    close: () => events.close(),
  };
}

/** The tab's hub; null outside a browser with EventSource. */
export function tabMarketStream(): MarketStreamHub | null {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return null;
  if (tab) return tab;
  const live = liveSourceState();
  const bucket = liveBucket();
  const schedule = (run: () => void, ms: number) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  };
  return (tab = new MarketStreamHub({
    createSource: (url) => liveMarketSource(url, live, {
      fetchTicket: () => fetchLiveTicket(bucket),
      openSocket: browserSocket,
      openEventSource: eventSource,
      schedule,
      now: Date.now,
      random: Math.random,
    }),
    schedule,
    defer: (run) => queueMicrotask(run),
    random: Math.random,
    visible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  }));
}
