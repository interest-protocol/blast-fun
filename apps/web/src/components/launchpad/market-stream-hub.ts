import { EVENT_CURSOR, compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { coinStatsFrameSchema, displayPriceCoinSchema, displayPriceFrameSchema, MARKET_STREAM_BUDGET, MARKET_STREAM_PATH, type CoinStatsFrame, type DisplayPriceFrame } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { deploymentMismatch, parseInfraProvenance, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { CANDLE_INTERVALS, type CandleInterval, type MigrationMarker, type PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { normalizeStructTag } from "@mysten/sui/utils";

import { parseChartFrame, type ChartFrame } from "./chart/chart-live-model.ts";
import { publishChartRound } from "./chart/chart-live-round.ts";
import { beginMarketHints, hintClientsAttached } from "#web/lib/live-stream/market-hints.ts";
import { createLiveTiming, TIMING_SAMPLE_RATE } from "#web/lib/live-stream/live-timing.ts";
import { browserLiveSource } from "#web/lib/live-stream/live-socket-source.ts";
import { presaleMarketFrameSchema, type PresaleMarketFrame } from "@blast/core/modules/live/presale-market-frames.ts";

/**
 * A pool's state on the tab's market stream. Only `live` and `stale` hold a fence (frames keep
 * following it); every other state voids it, and the pool's screens read it on their own polls.
 * - `live`: fenced, and the relay's upstream is making progress.
 * - `stale`: fenced, but the upstream is lost or lagging; frames may pause, so polls (with jitter) run too.
 * - `recovering`: the relay is fencing this pool again on the same socket (other pools keep streaming).
 * - `unavailable`: the reader does not know the pool (the relay asks again every minute), or the
 *   socket is refused for a while.
 * - `over_budget`: the tab's stream serves other pools (at most two); it clears when a slot frees.
 * - `connecting`, `reconnecting`, `paused`: the socket's own state (opening, backing off, hidden tab).
 */
export type MarketStreamState = "connecting" | "live" | "stale" | "recovering" | "reconnecting" | "paused" | "unavailable" | "over_budget";

/** A pool trade as its frame carried it. `summary` is the frame's pool summary, not validated here. */
export type MarketTrade = Readonly<{ poolKey: string; checkpoint: number; trade: PoolTrade; summary: unknown }>;

export type FenceDetail = Readonly<{ lastEvent: number; priceMissing?: true }>;

export type MarketStreamListener = Readonly<{
  /**
   * The subscription's summary: `live` while every pool it asked for is live (a price- or
   * presale-only subscription: while the socket is up), else its least live pool's state.
   * Screens over several pools use `pool` instead.
   */
  state: (state: MarketStreamState) => void;
  /** One requested pool's state, each time it changes. */
  pool?: (poolKey: string, state: MarketStreamState) => void;
  /**
   * The pool is live from this checkpoint: every later frame follows, in cursor order, once.
   * `lastEvent`: a checkpoint after which the stream delivers every pool event as a frame (the
   * fence's cursor or a later frame), so a history read that reaches it misses nothing. A pool can
   * be fenced again while it stays live (the relay re-fenced it, or a frame was lost): read again.
   */
  fence?: (poolKey: string, checkpoint: number, detail: FenceDetail) => void;
  /** Every validated frame after the fence; only for subscriptions that name a `migration`. */
  frame?: (frame: ChartFrame, chars: number) => void;
  trade?: (trade: MarketTrade) => void;
  prices?: (frame: DisplayPriceFrame) => void;
  /** The coin's latest market stats for a fenced pool; a later one replaces it, and a late subscriber gets the latest. */
  stats?: (frame: CoinStatsFrame) => void;
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
 * A screen that follows one coin's trades without asking for a stream. `live`: every pool of this coin
 * the tab streams is live (and there is one), so a quiet market is known to be quiet; `pools` holds
 * each of those pools' own state. It never changes which pools stream.
 */
export type CoinTradeListener = Readonly<{
  live: (live: boolean, pools?: ReadonlyMap<string, MarketStreamState>) => void;
  trade: (trade: MarketTrade) => void;
}>;

export type MarketStreamSubscription = Readonly<{
  /** The pool's state for this subscription; `over_budget` for a pool it did not ask for. */
  state: (poolKey: string) => MarketStreamState;
  /** True while the pool is `live`: its screens need no timer. */
  ready: (poolKey: string) => boolean;
  stop: () => void;
}>;

export interface MarketEventSource {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  /** `failed`: the caller gave up on it at a deadline, so a socket that never spoke counts against the tab. */
  close(failed?: boolean): void;
  /** Sends one message on the open socket; false when it is not open. */
  send(text: string): boolean;
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

/** `pending`: its first replay (the stream's progress so far) has not run yet. */
type Subscriber = { request: MarketStreamRequest; pools: ReadonlySet<string>; state: MarketStreamState | null; poolStates: Map<string, MarketStreamState>; pending: boolean };
type Observer = { coin: string; listener: CoinTradeListener; seen: string | null };
/**
 * `coin` survives reconnects: it names the pool, not the connection's progress through it.
 * `lastEvent`: a checkpoint after which every pool event arrives as a frame: the fence's cursor or a later frame.
 * `relay`: what the relay last said about an unfenced pool.
 * `awaiting`: the socket does not stream it yet (a `set` will add it); its frames are ignored until the answer.
 * `refences`: local re-fences in a row (bad or oversized frames); `cancelRefence` is the one waiting
 * its backoff, `cancelCalm` resets the count once a fence holds.
 */
type Pool = { fence: number | null; seen: number; lastEvent: number; cursor: string | null; tradeCursor: string | null; summary: unknown; coin: string | null; priceMissing?: boolean; stats?: CoinStatsFrame; relay: "waiting" | "recovering" | "unavailable"; awaiting: boolean; refences: number; cancelRefence: (() => void) | null; cancelCalm: (() => void) | null };
/** The topics one socket streams, as the relay names them. */
type Topics = Readonly<{ pools: readonly string[]; priceCoins: readonly string[]; presale: string | null }>;
const NO_TOPICS: Topics = { pools: [], priceCoins: [], presale: null };
/** A presale the tab no longer wants while the socket still streams it: wanted again before the relay drops it, it needs no new pong. */
type LeavingPresale = { id: string; fence: number | null; seen: number };
/**
 * `pools`, `priceCoins`, `presale`: what the tab wants streamed. `held`: what the socket streams (its URL, then
 * each `set` answer); `sent`: the one `set` waiting for its answer. `settable`: the hello said the relay takes `set`.
 * `leaving`: pools no longer wanted that the socket may still stream. `presaleAwaiting`: the presale waits for a
 * `set` answer, and its pongs are ignored until then.
 * `upstream`: what the relay last said about its own upstream (`recovering` while it reconnects, `stale` while it lags).
 */
type Connection = {
  pools: Map<string, Pool>; priceCoins: Set<string>; presale?: string; presaleFence: number | null; presaleSeen: number; expected: ExpectedDeployment | null;
  source: MarketEventSource | null; hello: boolean; upstream: "ok" | "recovering" | "stale"; unavailableLast: boolean;
  held: Topics; sent: (Topics & { seq: number }) | null; settable: boolean; leaving: Map<string, Pool>; leavingPresale: LeavingPresale | null; presaleAwaiting: boolean;
};
type Wanted = { pools: string[]; priceCoins: Set<string>; presale?: string; expected: ExpectedDeployment | null };
/** The socket: `open` once its hello arrived; `refused` while the tab waits out a refusal. */
type Socket = "connecting" | "open" | "reconnecting" | "paused" | "refused";

/** A stream with no hello by then is given up on (its socket counts as failed if it never spoke). */
export const HELLO_DEADLINE_MS = 10_000;
const LEGACY_HEARTBEAT_TIMEOUT_MS = 45_000;
/** A hidden tab keeps its stream this long, so a quick tab flip costs no reconnect or history read. */
export const HIDDEN_GRACE_MS = 15_000;
/**
 * With nothing wanted, the socket stays open this long, so the next page's screens reuse it with one `set`.
 * Then it closes, or, while hint clients read it, drops every topic with one `set` and stays.
 */
export const LINGER_MS = 5_000;
/** A `set` not answered by then reconnects, like a socket that stopped answering. */
export const SET_ANSWER_MS = 10_000;
/** A refusal that names no wait is retried after this long. */
const SET_RETRY_MS = 5_000;
/** A socket open this long resets the reconnect backoff. */
export const STABLE_MS = 20_000;
/** The reconnect backoff starts here and doubles up to `RECONNECT_MAX_MS`, with up to half again of jitter (capped). */
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 30_000;
/**
 * An older relay sends `unavailable` for a pool and then closes the socket; reopening at once loops.
 * After that shape the tab waits this long (with jitter), doubling up to `OLD_RELAY_MAX_MS`.
 */
export const OLD_RELAY_WAIT_MS = 60_000;
export const OLD_RELAY_MAX_MS = 300_000;
/** Waits before each local re-fence of one pool in a row; the count resets once a fence holds `REFENCE_CALM_MS`. */
export const LOCAL_REFENCE_WAITS_MS: readonly number[] = [0, 5_000, 10_000, 30_000];
export const REFENCE_CALM_MS = 60_000;
/** The least live state first: a subscription's summary is its first pool state in this order. */
const SUMMARY_ORDER: readonly MarketStreamState[] = ["paused", "reconnecting", "connecting", "unavailable", "over_budget", "recovering", "stale", "live"];

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

function nothingWanted(wanted: Wanted): boolean {
  return !wanted.pools.length && !wanted.priceCoins.size && !wanted.presale;
}

function wantedTopics(wanted: Wanted): Topics {
  return { pools: wanted.pools, priceCoins: [...wanted.priceCoins], presale: wanted.presale ?? null };
}

function topics(connection: Connection): Topics {
  return { pools: [...connection.pools.keys()], priceCoins: [...connection.priceCoins], presale: connection.presale ?? null };
}

/** The pools the socket holds or was last asked for. */
function streamedPools(connection: Connection): Set<string> {
  return new Set([...connection.held.pools, ...connection.sent?.pools ?? []]);
}

function sameTopics(left: Topics, right: Topics): boolean {
  const same = (a: readonly string[], b: readonly string[]) => {
    const other = new Set(b);
    return a.length === b.length && a.every((item) => other.has(item));
  };
  return left.presale === right.presale && same(left.pools, right.pools) && same(left.priceCoins, right.priceCoins);
}

/** The `held` of a `set` answer, or null when it is not one. */
function readHeld(value: unknown): Topics | null {
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
  if (value === null || typeof value !== "object") return null;
  const { pools, price_coins: priceCoins, presale } = value as Record<string, unknown>;
  if (!strings(pools) || !strings(priceCoins) || (presale !== null && typeof presale !== "string")) return null;
  return { pools, priceCoins, presale };
}

function fitsExpected(request: MarketStreamRequest, expected: ExpectedDeployment | null): boolean {
  return (!request.pools.length && request.expected === null) || sameExpected(request.expected, expected);
}

/** A round's state is whole at its checkpoint: no candle history, order or refetch depends on it. */
function round(frame: ChartFrame): void {
  if (frame.type === "opening_round") publishChartRound({ poolKey: frame.poolKey, openingRound: frame.openingRound, provenance: frame.provenance });
}

/** Runs one screen's listener: a listener that throws harms only itself, never the stream or other screens. */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    // The screen keeps its own fallback (its polls); the stream and its other screens go on.
  }
}

/** A JSON object, or null for anything else. */
function readObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A `status` without a pool: the relay's upstream. False when it changes nothing. */
function upstreamStatus(connection: Connection, state: unknown): boolean {
  switch (state) {
    case "recovering":
      connection.upstream = "recovering";
      return true;
    case "stale":
      if (connection.upstream === "ok") connection.upstream = "stale";
      return true;
    case "fresh":
      connection.upstream = "ok";
      return true;
    default:
      return false;
  }
}

/**
 * Each chart's frame for `wire`, and the frame trades use; null for an opening round, which is handled
 * here. Trades and lifecycles never read the migration; a candle is checked against each chart's. Throws on a bad frame.
 */
function parseFrames(wire: Record<string, unknown>, key: string, expected: ExpectedDeployment | null, charts: readonly Subscriber[]) {
  if (wire.type === "opening_round") {
    round(parseChartFrame(wire, key, expected, null));
    return null;
  }
  // The relay forwards candle intervals no chart reads (`1s`): skipped, not a bad frame.
  if (wire.type === "candle_closed" && (wire.interval === "1s" || !CANDLE_INTERVALS.includes(wire.interval as CandleInterval))) return { frames: [], frame: undefined };
  const shared = wire.type === "candle_closed" ? null : parseChartFrame(wire, key, expected, null);
  const frames = charts.map((subscriber) => [subscriber, shared ?? parseChartFrame(wire, key, expected, subscriber.request.migration!())] as const);
  return { frames, frame: shared ?? frames[0]?.[1] };
}

/** A frame with nothing to deliver still moves the pool's checkpoint on. */
function passed(pool: Pool, checkpoint: number | null): void {
  if (checkpoint === null) return;
  pool.seen = Math.max(pool.seen, checkpoint);
  pool.lastEvent = Math.max(pool.lastEvent, checkpoint);
}

/**
 * The fenced pool a frame is for, or null when the frame is dropped: a pool without a fence (not streamed
 * here, or re-fencing). A leaving pool only moves its checkpoint on, so a screen that brings it back reads
 * history through what it missed.
 */
function fencedPool(connection: Connection, key: string, checkpoint: number | null): Pool | null {
  const pool = connection.pools.get(key);
  if (pool) return pool.fence === null ? null : pool;
  const away = connection.leaving.get(key);
  if (away?.fence != null) passed(away, checkpoint);
  return null;
}

/** The checkpoint of a frame's cursor, or null when it names none. */
function cursorCheckpoint(value: unknown): number | null {
  if (typeof value !== "string" || !EVENT_CURSOR.test(value)) return null;
  const checkpoint = Number(value.split(":")[0]);
  return Number.isSafeInteger(checkpoint) ? checkpoint : null;
}

/** Advances the pool past `frame`; false when the stream already delivered it. */
function fresh(pool: Pool, frame: ChartFrame, summary: unknown): boolean {
  pool.seen = Math.max(pool.seen, frame.checkpoint);
  pool.lastEvent = Math.max(pool.lastEvent, frame.checkpoint);
  if (pool.cursor && compareEventCursors(frame.cursor, pool.cursor) <= 0) return false;
  pool.cursor = frame.cursor;
  if (frame.type !== "trade") return true;
  if (pool.tradeCursor && compareEventCursors(frame.trade.cursor, pool.tradeCursor) <= 0) return false;
  pool.tradeCursor = frame.trade.cursor;
  pool.summary = summary ?? null;
  if (frame.trade.kind !== "opening_round_fill") pool.priceMissing = frame.trade.price === null;
  return true;
}

function emptyPool(coin: string | null, awaiting = false): Pool {
  return { fence: null, seen: 0, lastEvent: 0, cursor: null, tradeCursor: null, summary: null, coin, relay: "waiting", awaiting, refences: 0, cancelRefence: null, cancelCalm: null };
}

/** Voids the pool's fence; the next `status: live` (or a new connection) fences it again. */
function unfence(pool: Pool, relay: Pool["relay"]): void {
  pool.cancelRefence?.();
  pool.cancelCalm?.();
  Object.assign(pool, { cancelRefence: null, cancelCalm: null, fence: null, seen: 0, lastEvent: 0, cursor: null, tradeCursor: null, stats: undefined, relay });
}

/**
 * One bounded market stream per tab: at most two pools, shared by every screen that watches them.
 * The tab keeps one socket: a page that changes what it watches sends one `set` with the whole wanted
 * set (one in flight at a time). `LINGER_MS` after nothing is wanted, the socket closes, or, while
 * hint clients read its hints, it streams no topics and stays, so they never need a socket of their own.
 * Each pool has its own state: one pool's fault (unknown, re-fencing, a bad frame) never ends the
 * socket or another pool's stream. Only a missing hello, heartbeat or `set` answer, a socket close,
 * or the relay's `resync` reconnects, with a 500 ms to 30 s backoff.
 */
export class MarketStreamHub {
  private readonly deps: MarketStreamDependencies;
  /** Newest first. */
  private readonly subscribers: Subscriber[] = [];
  private readonly active = new Set<Subscriber>();
  private readonly observers = new Set<Observer>();
  private connection: Connection | null = null;
  private hints: ReturnType<typeof beginMarketHints> | null = null;
  private attempts = 0;
  /** Old-relay closes in a row (see `OLD_RELAY_WAIT_MS`). */
  private oldRelayWaits = 0;
  private socket: Socket = "connecting";
  private reconciling = false;
  private cancelHeartbeat: (() => void) | null = null;
  private cancelHello: (() => void) | null = null;
  /** A pending reconnect: the backoff, or the end of a refusal. */
  private cancelReconnect: (() => void) | null = null;
  private cancelHidden: (() => void) | null = null;
  private cancelStable: (() => void) | null = null;
  private stopVisibility: (() => void) | null = null;
  /** The deadline of the `set` in flight (`SET_ANSWER_MS`). */
  private cancelAnswer: (() => void) | null = null;
  /** The wait a refused `set` named before the next one. */
  private cancelRetry: (() => void) | null = null;
  /** The close once nothing is wanted (`LINGER_MS`). */
  private cancelLinger: (() => void) | null = null;
  /**
   * Nothing is wanted and the socket stays for hint clients (it streams no topics once the linger ends).
   * They leave with each drop or pause and come back with their own backoff, so it closes only once it is
   * up (or the tab is visible) `LINGER_MS` with none attached.
   */
  private keptForHints = false;
  private seq = 0;

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
    const subscriber: Subscriber = { request, pools: new Set(request.pools), state: null, poolStates: new Map(), pending: this.connection !== null };
    this.subscribers.unshift(subscriber);
    this.active.add(subscriber);
    this.stopVisibility ??= this.deps.onVisibilityChange(() => this.visibility());
    if (this.connection) {
      this.queueReconcile();
      // A later subscriber to a live pool starts from what the stream already delivered.
      this.deps.defer(() => this.replay(subscriber));
    } else this.reconcile();
    return {
      state: (pool) => this.active.has(subscriber) && subscriber.pools.has(pool) ? this.poolState(subscriber, pool) : "over_budget",
      ready: (pool) => this.active.has(subscriber) && subscriber.pools.has(pool) && this.poolState(subscriber, pool) === "live",
      stop: () => {
        if (!this.active.delete(subscriber)) return;
        this.subscribers.splice(this.subscribers.indexOf(subscriber), 1);
        this.queueReconcile();
      },
    };
  }

  /** Follows `coinType`'s trades on whatever the tab already streams; it never opens or widens a stream. */
  observe(coinType: string, listener: CoinTradeListener): () => void {
    const coin = coinKey(coinType);
    // A malformed coin type never streams: its screens stay on their polls.
    if (!coin) return () => {};
    const observer: Observer = { coin, listener, seen: null };
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

  /**
   * Newest subscribers first, pool by pool while they fit one stream: a request over the budget gets
   * the part that fits, and the rest is `over_budget` until a slot frees.
   */
  private wanted(): Wanted {
    const pools = new Set<string>();
    const priceCoins = new Set<string>();
    const presale = this.subscribers.find(({ request }) => request.presale !== undefined)?.request.presale;
    const expected = this.subscribers.find(({ request }) => request.pools.length > 0 || request.expected !== null)?.request.expected ?? null;
    for (const { request } of this.subscribers) {
      if (!fitsExpected(request, expected)) continue;
      for (const pool of request.pools) if (pools.size < MARKET_STREAM_BUDGET.maxPoolsPerClient) pools.add(pool);
      for (const coin of request.priceCoins ?? []) if (priceCoins.size < MARKET_STREAM_BUDGET.maxPriceCoinsPerClient) priceCoins.add(coin);
    }
    return { pools: [...pools], priceCoins, presale, expected };
  }

  /** Each pool's coin, as its subscribers name it. */
  private nameCoins(connection: Connection): void {
    for (const { request } of this.subscribers) {
      const coin = coinKey(request.coin);
      const pools = coin ? request.pools.map((key) => connection.pools.get(key)) : [];
      for (const pool of pools) if (pool) pool.coin = coin;
    }
  }

  /** Whether this connection streams `pool` for the subscriber. */
  private serves(subscriber: Subscriber, pool: string): boolean {
    const connection = this.connection;
    return connection !== null && connection.pools.has(pool) && fitsExpected(subscriber.request, connection.expected);
  }

  private reconcile(): void {
    const wanted = this.wanted();
    if (nothingWanted(wanted)) {
      if (hintClientsAttached()) this.keptForHints = true;
      return this.linger();
    }
    this.cancelLinger?.();
    this.cancelLinger = null;
    this.keptForHints = false;
    const current = this.connection;
    if (current && (!current.hello || current.settable) && !this.conflicts(current, wanted)) this.change(current, wanted);
    else if (!current || !sameExpected(current.expected, wanted.expected) || !sameTopics(topics(current), wantedTopics(wanted))) this.redial(wanted);
    this.nameCoins(this.connection!);
    this.publish();
  }

  /**
   * Nothing is wanted: the socket stays for the next page's screens, then closes. While hint clients read it
   * (an open sale page), it sends one `set` with no topics instead and stays, until the last one leaves.
   */
  private linger(): void {
    if (!this.connection) return this.close();
    this.cancelLinger ??= this.deps.schedule(() => {
      this.cancelLinger = null;
      const connection = this.connection!;
      const wanted = this.wanted();
      if (!nothingWanted(wanted)) return;
      // A kept socket paused in a hidden tab decides once the tab is back (`connect`).
      const away = this.keptForHints && !connection.source && !this.deps.visible();
      if (!hintClientsAttached() && !away) return this.close();
      // A relay without `set` cannot drop the topics: its hint clients fall back to their own socket.
      if (connection.hello && !connection.settable && !sameTopics(connection.held, NO_TOPICS)) return this.close();
      this.keptForHints = true;
      this.empty(connection);
      this.publish();
    }, LINGER_MS);
  }

  /** Drops every topic, by one `set` on an open socket. The deployment stays: streamed pools wait in `leaving` for the answer. */
  private empty(connection: Connection): void {
    this.change(connection, { ...this.wanted(), expected: connection.expected });
  }

  /** The last hint client left: a socket that wants no topics closes a linger after this leave. */
  private hintsLeft(): void {
    if (!this.connection || !nothingWanted(this.wanted())) return;
    this.cancelLinger?.();
    this.cancelLinger = null;
    this.linger();
  }

  /**
   * A pool the socket streams (or will) was fenced against another deployment: it gets no new fence by
   * `set` (kept pools are untouched), so the tab opens a new socket. That is any streamed pool when the
   * deployment changes now, and a streamed pool the hub no longer tracks, which an earlier change dropped.
   */
  private conflicts(connection: Connection, wanted: Wanted): boolean {
    const streamed = streamedPools(connection);
    if (!sameExpected(connection.expected, wanted.expected)) return wanted.pools.some((pool) => streamed.has(pool));
    return wanted.pools.some((pool) => streamed.has(pool) && !connection.pools.has(pool) && !connection.leaving.has(pool));
  }

  /** A new socket for `wanted`; the old one, if any, is closed first. */
  private redial(wanted: Wanted): void {
    const current = this.connection;
    const refused = this.socket === "refused" && this.cancelReconnect !== null;
    this.drop();
    this.connection = {
      pools: new Map(wanted.pools.map((pool) => [pool, emptyPool(current?.pools.get(pool)?.coin ?? null)])), priceCoins: wanted.priceCoins, presale: wanted.presale,
      presaleFence: null, presaleSeen: 0, expected: wanted.expected, source: null, hello: false, upstream: "ok", unavailableLast: false,
      held: NO_TOPICS, sent: null, settable: false, leaving: new Map(), leavingPresale: null, presaleAwaiting: false,
    };
    this.attempts = 0;
    // While a refusal lasts the source answers `refused` at once.
    this.socket = refused || this.deps.visible() ? "connecting" : "paused";
    this.nameCoins(this.connection);
    // The new socket needs a new hint handshake. The new carrier replaces the old in one step, so hint
    // clients keep waiting for it (even while hidden) rather than open their own socket.
    this.hints = beginMarketHints(() => this.hintsLeft());
    if (this.deps.visible()) this.connect();
    else this.pause();
  }

  /**
   * Changes what the tab wants on the same socket: kept pools keep their fences, added ones wait for the
   * `set` answer and their fence, and removed ones the socket still streams wait in `leaving`, so a screen
   * that comes back before the relay drops them needs no new fence.
   */
  private change(connection: Connection, wanted: Wanted): void {
    const restored = this.changePools(connection, wanted.pools);
    if (!sameExpected(connection.expected, wanted.expected)) {
      connection.expected = wanted.expected;
      // Fenced against the old deployment: never brought back (`conflicts` redials for one the socket still streams).
      for (const pool of connection.leaving.values()) unfence(pool, "waiting");
      connection.leaving.clear();
    }
    connection.priceCoins = wanted.priceCoins;
    const presaleBack = this.changePresale(connection, wanted.presale);
    this.sync();
    // Screens already watching a pool that comes back (a freed budget slot) read from its fence again; new screens get their replay.
    if (!restored.length && !presaleBack) return;
    for (const subscriber of [...this.subscribers]) if (!subscriber.pending) this.replay(subscriber, { pools: restored, presale: presaleBack });
  }

  /** Rebuilds the pools in wanted order; returns the ones back from `leaving` with their fence. */
  private changePools(connection: Connection, wanted: readonly string[]): string[] {
    const streamed = connection.source === null ? new Set<string>() : streamedPools(connection);
    const pools = new Map<string, Pool>();
    const restored: string[] = [];
    for (const key of wanted) {
      const pool = connection.pools.get(key) ?? connection.leaving.get(key);
      if (pool && connection.leaving.delete(key) && pool.fence !== null) restored.push(key);
      pools.set(key, pool ?? emptyPool(null, true));
    }
    for (const [key, pool] of connection.pools) {
      if (pools.has(key)) continue;
      if (streamed.has(key)) connection.leaving.set(key, pool);
      else unfence(pool, "waiting");
    }
    connection.pools = pools;
    return restored;
  }

  /** True when the presale comes back from `leavingPresale` with its fence. */
  private changePresale(connection: Connection, presale: string | undefined): boolean {
    if (presale === connection.presale) return false;
    const old = connection.presale;
    const away = connection.leavingPresale;
    const back = away?.id === presale ? away : null;
    const socketHas = (id: string) => connection.source !== null && (connection.held.presale === id || connection.sent?.presale === id);
    if (old && socketHas(old)) connection.leavingPresale = { id: old, fence: connection.presaleFence, seen: connection.presaleSeen };
    else if (away && away !== back && socketHas(away.id)) connection.leavingPresale = away;
    else connection.leavingPresale = null;
    connection.presale = presale;
    connection.presaleFence = back?.fence ?? null;
    connection.presaleSeen = back?.seen ?? 0;
    // One brought back from a `set` still unanswered waits for that answer, like a new one.
    connection.presaleAwaiting = presale !== undefined && connection.held.presale !== presale;
    return back?.fence != null;
  }

  /**
   * Sends what the tab wants when the socket holds something else: one `set` in flight, none before a
   * hello that takes `set`, none while a refusal's wait lasts. No answer by `SET_ANSWER_MS` reconnects.
   */
  private sync(): void {
    const connection = this.connection;
    const source = connection?.source;
    if (!connection || !source || !connection.settable || connection.sent || this.cancelRetry) return;
    const next = topics(connection);
    if (sameTopics(next, connection.held)) return;
    const seq = ++this.seq;
    if (!source.send(JSON.stringify({ op: "set", seq, pools: next.pools, price_coins: next.priceCoins, presale: next.presale }))) return this.reconnect();
    connection.sent = { ...next, seq };
    this.cancelAnswer = this.deps.schedule(() => {
      this.cancelAnswer = null;
      if (this.connection === connection && connection.source === source) this.reconnect(true);
    }, SET_ANSWER_MS);
  }

  /**
   * The answer to the `set` in flight. `held` is what the socket now streams: on a refusal, the removals
   * applied and the additions did not. A refused added pool is `unavailable` (its screens poll) until the
   * retry after `retryMs`.
   */
  private answered(connection: Connection, sent: Topics, held: Topics, retryMs: number | null): void {
    this.cancelAnswer?.();
    this.cancelAnswer = null;
    connection.sent = null;
    connection.held = held;
    this.heldPools(connection, sent, held);
    this.heldPresale(connection, held);
    if (retryMs !== null) {
      this.cancelRetry = this.deps.schedule(() => {
        this.cancelRetry = null;
        if (this.connection === connection) this.sync();
      }, Math.round(retryMs * (1 + this.deps.random() / 2)));
    }
    this.sync();
    this.publish();
  }

  /** After an answer: added pools wait for their fence, refused ones wait for the next `set`, dropped leaving ones go. */
  private heldPools(connection: Connection, sent: Topics, held: Topics): void {
    const kept = new Set(held.pools);
    const asked = new Set(sent.pools);
    for (const [key, pool] of connection.pools) {
      if (kept.has(key)) {
        // Added: its fence follows the answer.
        if (pool.awaiting) Object.assign(pool, { awaiting: false, relay: "waiting" });
        continue;
      }
      // Brought back from `leaving` after this `set` removed it: the next one adds it again.
      if (!pool.awaiting) unfence(pool, "waiting");
      pool.awaiting = true;
      if (asked.has(key)) pool.relay = "unavailable";
    }
    for (const [key, pool] of connection.leaving) {
      // Removed while its own `set` was in flight: the socket streams it now, so it hears its fence.
      if (kept.has(key)) pool.awaiting = false;
      else {
        unfence(pool, "waiting");
        connection.leaving.delete(key);
      }
    }
  }

  /** After an answer: the presale is streamed, or waits for the next `set` with its state cleared. */
  private heldPresale(connection: Connection, held: Topics): void {
    if (connection.leavingPresale && connection.leavingPresale.id !== held.presale) connection.leavingPresale = null;
    const presale = connection.presale ?? null;
    if (presale !== null && held.presale === presale) connection.presaleAwaiting = false;
    else if (presale !== null && !connection.presaleAwaiting) {
      connection.presaleAwaiting = true;
      connection.presaleSeen = 0;
      this.presaleState(connection, null);
    }
  }

  /** Tells a subscriber the stream's progress so far; `only`: just these pools and the presale if true. */
  private replay(subscriber: Subscriber, only?: Readonly<{ pools: readonly string[]; presale: boolean }>): void {
    if (!only) subscriber.pending = false;
    const connection = this.connection;
    if (!connection?.source || !this.active.has(subscriber)) return;
    const { request } = subscriber;
    if (request.presale && request.presale === connection.presale && connection.presaleFence !== null && (!only || only.presale))
      safely(() => request.listener.presaleReady?.(Math.max(connection.presaleFence!, connection.presaleSeen)));
    for (const key of only?.pools ?? request.pools) {
      if (!subscriber.pools.has(key)) continue;
      const pool = connection.pools.get(key);
      if (!pool || pool.fence === null || !this.serves(subscriber, key) || !this.active.has(subscriber)) continue;
      this.notifyFence(subscriber, key, pool);
      if (pool.stats) safely(() => request.listener.stats?.(pool.stats!));
    }
  }

  private notifyFence(subscriber: Subscriber, key: string, pool: Pool): void {
    const checkpoint = Math.max(pool.fence ?? 0, pool.seen);
    safely(() => subscriber.request.listener.fence?.(key, checkpoint, { lastEvent: pool.lastEvent, ...(pool.priceMissing ? { priceMissing: true } : {}) }));
  }

  /** Tells the pool's subscribers its (new) fence. */
  private fenced(connection: Connection, key: string, pool: Pool): void {
    for (const subscriber of [...this.subscribers]) {
      if (this.connection !== connection || pool.fence === null) return;
      if (subscriber.pools.has(key) && this.active.has(subscriber) && this.serves(subscriber, key)) this.notifyFence(subscriber, key, pool);
    }
  }

  private poolState(subscriber: Subscriber, key: string): MarketStreamState {
    const connection = this.connection;
    if (!connection || !this.serves(subscriber, key)) return "over_budget";
    return this.servedState(connection, connection.pools.get(key)!);
  }

  /** The state of a pool this tab streams. */
  private servedState(connection: Connection, pool: Pool): MarketStreamState {
    switch (this.socket) {
      case "refused": return "unavailable";
      case "paused": return "paused";
      case "reconnecting": return "reconnecting";
      case "connecting": return "connecting";
    }
    if (pool.cancelRefence) return "recovering";
    if (pool.fence !== null) return connection.upstream === "ok" ? "live" : "stale";
    if (pool.relay === "unavailable") return "unavailable";
    return pool.relay === "recovering" || connection.upstream === "recovering" ? "recovering" : "connecting";
  }

  private summaryState(subscriber: Subscriber, states: readonly MarketStreamState[]): MarketStreamState {
    if (states.length) return SUMMARY_ORDER.find((state) => states.includes(state))!;
    const connection = this.connection;
    const { request } = subscriber;
    if (!connection || !fitsExpected(request, connection.expected) || (request.presale !== undefined && request.presale !== connection.presale)) return "over_budget";
    return this.socket === "open" ? "live" : this.socket === "refused" ? "unavailable" : this.socket;
  }

  /** Tells every subscriber each pool state that changed, then its summary, then the coin observers. */
  private publish(): void {
    for (const subscriber of [...this.subscribers]) {
      if (!this.active.has(subscriber)) continue;
      const { listener } = subscriber.request;
      const states: MarketStreamState[] = [];
      for (const key of subscriber.request.pools) {
        const state = this.poolState(subscriber, key);
        states.push(state);
        if (subscriber.poolStates.get(key) === state) continue;
        subscriber.poolStates.set(key, state);
        if (listener.pool) safely(() => listener.pool!(key, state));
      }
      if (!this.active.has(subscriber)) continue;
      const state = this.summaryState(subscriber, states);
      if (subscriber.state === state) continue;
      subscriber.state = state;
      safely(() => listener.state(state));
    }
    this.observed();
  }

  private presaleState(connection: Connection, checkpoint: number | null): void {
    if (connection.presaleFence === checkpoint) return;
    connection.presaleFence = checkpoint;
    for (const subscriber of [...this.subscribers]) {
      const { request } = subscriber;
      if (request.presale && request.presale === connection.presale && this.active.has(subscriber)) safely(() => request.listener.presaleReady?.(checkpoint));
    }
  }

  /** The state of each pool of `coin` this tab streams. */
  private coinPools(coin: string): Map<string, MarketStreamState> {
    const pools = new Map<string, MarketStreamState>();
    const connection = this.connection;
    if (!connection) return pools;
    for (const [key, pool] of connection.pools) if (pool.coin === coin) pools.set(key, this.servedState(connection, pool));
    return pools;
  }

  /** Tells each observer whose coin's pools changed state. */
  private observed(): void {
    for (const observer of [...this.observers]) {
      const pools = this.coinPools(observer.coin);
      const seen = [...pools].map(([key, state]) => `${key}=${state}`).join(",");
      if (observer.seen === seen || !this.observers.has(observer)) continue;
      const live = pools.size > 0 && [...pools.values()].every((state) => state === "live");
      observer.seen = seen;
      // Every change of any pool's state is told; `live` may repeat, so listeners treat it as a level.
      safely(() => observer.listener.live(live, pools));
    }
  }

  private visibility(): void {
    if (this.deps.visible()) {
      this.cancelHidden?.();
      this.cancelHidden = null;
      if (this.connection && !this.connection.source) {
        this.hints ??= beginMarketHints(() => this.hintsLeft());
        // Shown again: connect at once, past any pending backoff or refusal (a refusal still in force answers at once).
        this.cancelReconnect?.();
        this.cancelReconnect = null;
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
    // Hint clients wait for the hello that follows the tab's return, not open their own socket.
    this.hints?.disconnected();
    this.socket = "paused";
    this.publish();
  }

  private close(): void {
    this.cancelLinger?.();
    this.cancelLinger = null;
    this.keptForHints = false;
    this.drop();
    this.connection = null;
    this.hints?.stop();
    this.hints = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    this.observed();
  }

  /** Ends the current source and every timer that belongs to it; pools lose their fences. */
  private drop(deadline = false): void {
    const connection = this.connection;
    this.cancelAnswer?.();
    this.cancelAnswer = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
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
    connection.source?.close(deadline);
    connection.source = null;
    connection.hello = false;
    connection.upstream = "ok";
    connection.unavailableLast = false;
    connection.held = NO_TOPICS;
    connection.sent = null;
    connection.settable = false;
    connection.leavingPresale = null;
    connection.presaleAwaiting = false;
    this.presaleState(connection, null);
    connection.presaleSeen = 0;
    for (const pool of [...connection.pools.values(), ...connection.leaving.values()]) {
      unfence(pool, "waiting");
      pool.summary = null;
    }
    connection.leaving.clear();
  }

  private connect(): void {
    const connection = this.connection;
    if (!connection) return;
    if (nothingWanted(this.wanted())) {
      // A reconnect or a shown tab during the linger: nobody would read the new socket.
      if (!this.keptForHints && !hintClientsAttached()) return this.close();
      // Kept for hint clients: the new socket streams no topics, and they come back to it within a linger, or it closes.
      this.keptForHints = true;
      this.empty(connection);
      this.cancelLinger?.();
      this.cancelLinger = null;
      this.linger();
    }
    const params = new URLSearchParams();
    params.set("activity", "true");
    for (const key of connection.pools.keys()) params.append("pool", key);
    for (const coin of connection.priceCoins) params.append("price_coin", coin);
    if (connection.presale) params.set("presale", connection.presale);
    this.socket = "connecting";
    const source = this.deps.createSource(`${MARKET_STREAM_PATH}?${params}`);
    connection.source = source;
    // The URL names everything the tab wants: nothing waits for a `set`.
    connection.held = topics(connection);
    for (const pool of connection.pools.values()) pool.awaiting = false;
    connection.presaleAwaiting = false;
    connection.hello = false;
    connection.upstream = "ok";
    connection.unavailableLast = false;
    this.publish();
    const current = () => this.connection === connection && connection.source === source;
    // Only a missing hello ends a socket that answers: a pool without its fence is that pool's alone.
    this.cancelHello = this.deps.schedule(() => { if (current()) this.reconnect(true); }, HELLO_DEADLINE_MS);
    let heartbeatTimeoutMs: number | null = null;
    const expectHeartbeat = () => {
      if (!current() || heartbeatTimeoutMs === null) return;
      this.cancelHeartbeat?.();
      this.cancelHeartbeat = this.deps.schedule(() => {
        if (current()) this.reconnect(true);
      }, heartbeatTimeoutMs);
    };
    const confirmPong = (checkpoint: unknown) => {
      // The handshake pong is the first confirmed upstream heartbeat.
      if (heartbeatTimeoutMs === MARKET_STREAM_BUDGET.heartbeatTimeoutMs) expectHeartbeat();
      if (typeof checkpoint !== "number" || !Number.isSafeInteger(checkpoint) || checkpoint < 0) return;
      // A pong before the answer that adds the presale is not this presale's. One for a presale left
      // while its `set` was in flight is the leaving presale's, so it comes back ready.
      const away = connection.leavingPresale;
      if (connection.presale !== undefined && !connection.presaleAwaiting) this.presaleState(connection, checkpoint);
      else if (away && away.id === connection.held.presale) away.fence = checkpoint;
    };
    // Anything after an `unavailable` shows this relay keeps the socket open (an older one closes it at once).
    source.addEventListener("heartbeat", () => { connection.unavailableLast = false; expectHeartbeat(); });
    source.addEventListener("status", (event) => { if (current()) this.status(connection, event.data ?? ""); });
    source.addEventListener("market", (event) => { if (!current()) return; connection.unavailableLast = false; this.market(connection, event.data ?? ""); });
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
        if (!priceCoins?.length || !listener.prices || !this.active.has(subscriber) || !fitsExpected(subscriber.request, connection.expected) || !current()) continue;
        const requested = new Set(priceCoins);
        const prices = frame.prices.filter((price) => requested.has(price.coin_type));
        if (prices.length) safely(() => listener.prices!({ ...frame, prices }));
      }
    });
    source.addEventListener("stats", (event) => {
      if (!current() || !event.data || event.data.length > MARKET_STREAM_BUDGET.maxChunkBytes) return;
      let frame: CoinStatsFrame;
      try {
        frame = coinStatsFrameSchema.parse(JSON.parse(event.data));
        const provenance = parseInfraProvenance(frame.provenance);
        if (provenance.checkpoint !== frame.checkpoint || deploymentMismatch(provenance, connection.expected)) return;
      } catch {
        return;
      }
      // A leaving pool keeps its stats current (no screen hears them), so it comes back with the newest.
      const target = connection.pools.get(frame.pool_key) ?? connection.leaving.get(frame.pool_key);
      if (target?.fence == null) return;
      // One coin can span two pools (curve, then venue): only its newest stats count, from either pool.
      const others = [...connection.pools.values(), ...connection.leaving.values()].filter((pool) => pool.stats?.coin === frame.coin);
      const newer = ({ checkpoint, cursor }: CoinStatsFrame): boolean => checkpoint > frame.checkpoint || (checkpoint === frame.checkpoint && compareEventCursors(cursor, frame.cursor) > 0);
      if (others.some((pool) => newer(pool.stats!))) return;
      for (const pool of others) pool.stats = undefined;
      target.stats = frame;
      for (const subscriber of [...this.subscribers]) {
        const { listener } = subscriber.request;
        if (listener.stats && subscriber.pools.has(frame.pool_key) && this.active.has(subscriber) && this.serves(subscriber, frame.pool_key) && current()) safely(() => listener.stats!(frame));
      }
    });
    // A deployment mismatch (or an older relay giving up): the relay ends this socket; reconnect with backoff.
    source.addEventListener("resync", () => { if (current()) this.reconnect(); });
    source.addEventListener("presale", (event) => {
      if (!current() || (connection.presaleFence === null && !connection.leavingPresale) || !event.data || event.data.length > MARKET_STREAM_BUDGET.maxChunkBytes) return;
      let frame: PresaleMarketFrame;
      try {
        frame = presaleMarketFrameSchema.parse(JSON.parse(event.data));
      } catch {
        return;
      }
      const checkpoint = Number(frame.cursor.split(":", 1)[0]);
      const away = connection.leavingPresale;
      if (away?.id === frame.presale_id) away.seen = Math.max(away.seen, checkpoint);
      if (connection.presaleFence === null || frame.presale_id !== connection.presale) return;
      connection.presaleSeen = Math.max(connection.presaleSeen, checkpoint);
      for (const subscriber of [...this.subscribers]) {
        if (current() && this.active.has(subscriber) && subscriber.request.presale === frame.presale_id) {
          safely(() => subscriber.request.listener.presale?.(frame));
        }
      }
    });
    // A drop after the stream opened: retried with backoff.
    source.addEventListener("error", () => { if (current()) this.reconnect(); });
    source.addEventListener("set", (event) => {
      const sent = connection.sent;
      const answer = current() && sent ? readObject(event.data ?? "") : null;
      if (!answer || answer.seq !== sent!.seq) return;
      const held = readHeld(answer.held);
      if (!held) return this.reconnect();
      const retryMs = typeof answer.retry_ms === "number" && Number.isFinite(answer.retry_ms) && answer.retry_ms >= 0 ? answer.retry_ms : SET_RETRY_MS;
      this.answered(connection, sent!, held, answer.ok === true ? null : retryMs);
    });
    // The socket is off or backing off for `data` ms: polls carry the page until then. A pool change, or
    // the tab shown again, asks the source again, and it answers at once while the wait lasts.
    source.addEventListener("refused", (event) => {
      if (!current()) return;
      this.hints?.disconnected();
      this.drop();
      this.socket = "refused";
      this.cancelReconnect = this.deps.schedule(() => {
        this.cancelReconnect = null;
        if (this.connection !== connection) return;
        if (!this.deps.visible()) return this.pause();
        this.connect();
      }, Math.max(0, Number(event.data) || 0));
      this.publish();
    });
    source.addEventListener("hint", (event) => {
      if (!current() || !event.data) return;
      try {
        const hint = JSON.parse(event.data) as Record<string, unknown>;
        if (hint.type === "hello" && parseInfraProvenance(hint.provenance).network === "mainnet" && !connection.hello) {
          connection.hello = true;
          connection.settable = hint.set === true;
          this.socket = "open";
          this.cancelHello?.();
          this.cancelHello = null;
          this.cancelStable?.();
          this.cancelStable = this.deps.schedule(() => {
            this.cancelStable = null;
            this.attempts = 0;
            this.oldRelayWaits = 0;
          }, STABLE_MS);
          if (hint.heartbeat === true) {
            heartbeatTimeoutMs = hint.heartbeat_ms === MARKET_STREAM_BUDGET.heartbeatMs
              ? MARKET_STREAM_BUDGET.heartbeatTimeoutMs
              : LEGACY_HEARTBEAT_TIMEOUT_MS;
            expectHeartbeat();
          }
          this.publish();
          this.helloSync(connection);
        } else if (connection.hello && hint.type === "pong") {
          confirmPong(hint.presale_checkpoint);
        }
      } catch { /* The hint carrier refuses malformed hints independently. */ }
      if (current()) this.hints?.frame(event.data);
    });
  }

  /** After the hello: what changed before it goes by `set`, or, on an older relay without `set`, by a new socket. */
  private helloSync(connection: Connection): void {
    if (connection.settable) return this.sync();
    if (sameTopics(topics(connection), connection.held)) return;
    const wanted = this.wanted();
    if (!nothingWanted(wanted)) this.redial(wanted);
  }

  /**
   * A `status` frame. Per pool: `live` (a fence), `recovering` (the relay is fencing it again) or
   * `unavailable` (the reader does not know it). Without a pool, the relay's upstream: `recovering`
   * (lost, reconnecting), `stale` (no progress) and `fresh`. A status this hub cannot read changes nothing.
   */
  private status(connection: Connection, data: string): void {
    const status = readObject(data);
    if (!status) return;
    connection.unavailableLast = status.state === "unavailable" && typeof status.pool_key === "string";
    const changed = typeof status.pool_key === "string" ? this.poolStatus(connection, status.pool_key, status) : upstreamStatus(connection, status.state);
    if (changed && this.connection === connection) this.publish();
  }

  /** A `status` naming a pool; false when it changes nothing. */
  private poolStatus(connection: Connection, key: string, status: Record<string, unknown>): boolean {
    // A leaving pool keeps its fence current; an awaiting one hears nothing before the `set` answer.
    const pool = connection.pools.get(key) ?? connection.leaving.get(key);
    if (!pool || pool.awaiting) return false;
    switch (status.state) {
      case "live":
        if (!this.fence(connection, key, pool, status)) unfence(pool, "recovering");
        return true;
      case "recovering":
        unfence(pool, "recovering");
        return true;
      case "unavailable":
        // An older relay closes the socket right after; this relay asks again every minute and may send `live`.
        unfence(pool, "unavailable");
        return true;
      default:
        return false;
    }
  }

  /** Fences `pool` from a `status: live`; false when the status is not a valid fence for this stream. */
  private fence(connection: Connection, key: string, pool: Pool, status: Record<string, unknown>): boolean {
    let provenance: ReturnType<typeof parseInfraProvenance>;
    try {
      provenance = parseInfraProvenance(status.provenance);
    } catch {
      return false;
    }
    const checkpoint = status.checkpoint;
    const cursor = status.cursor;
    if (typeof checkpoint !== "number" || !Number.isSafeInteger(checkpoint) || checkpoint < 0 || provenance.checkpoint !== checkpoint ||
      deploymentMismatch(provenance, connection.expected) || typeof cursor !== "string" || !EVENT_CURSOR.test(cursor)) return false;
    const lastEvent = Number(cursor.split(":")[0]);
    if (BigInt(cursor.split(":")[0]) > BigInt(checkpoint)) return false;
    pool.cancelRefence?.();
    Object.assign(pool, { fence: checkpoint, seen: checkpoint, lastEvent, cursor: null, tradeCursor: null, priceMissing: status.price_missing === true, relay: "waiting", cancelRefence: null });
    this.fenced(connection, key, pool);
    return true;
  }

  /**
   * A frame was lost or unusable for a fenced pool: it is fenced again here, at the newest checkpoint
   * the stream reached, so its screens read history through it. The socket and other pools go on.
   */
  private refenceLocally(connection: Connection, key: string, pool: Pool, checkpoint: number | null): void {
    pool.seen = Math.max(pool.fence ?? 0, pool.seen, checkpoint ?? 0);
    // One re-fence at a time; repeats back off, so a bad frame on every trade costs few history reads.
    if (pool.cancelRefence) return;
    pool.cancelCalm?.();
    pool.cancelCalm = null;
    const wait = LOCAL_REFENCE_WAITS_MS[Math.min(pool.refences++, LOCAL_REFENCE_WAITS_MS.length - 1)]!;
    const refence = () => {
      pool.cancelRefence = null;
      if (this.connection !== connection || !connection.source || pool.fence === null) return;
      const at = Math.max(pool.fence, pool.seen);
      pool.fence = at;
      pool.seen = at;
      pool.lastEvent = Math.max(pool.lastEvent, at);
      pool.cancelCalm = this.deps.schedule(() => {
        pool.cancelCalm = null;
        pool.refences = 0;
      }, REFENCE_CALM_MS);
      if (wait) this.publish();
      this.fenced(connection, key, pool);
    };
    if (!wait) return refence();
    // Meanwhile the pool is `recovering`: its frames are dropped and its screens poll.
    pool.cancelRefence = this.deps.schedule(refence, wait);
    this.publish();
  }

  /** A frame no pool can be blamed for: every fenced pool reads again. */
  private refenceAll(connection: Connection): void {
    for (const [key, pool] of connection.pools) if (pool.fence !== null && this.connection === connection) this.refenceLocally(connection, key, pool, null);
  }

  private market(connection: Connection, data: string): void {
    const wire = readObject(data);
    if (!wire) return this.refenceAll(connection);
    const key = String(wire.pool_key ?? (wire.trade as Record<string, unknown> | undefined)?.pool_key);
    const checkpoint = cursorCheckpoint(wire.cursor);
    const pool = fencedPool(connection, key, checkpoint);
    if (!pool) return;
    if (pool.cancelRefence) return passed(pool, checkpoint);
    if (data.length > MARKET_STREAM_BUDGET.maxUpstreamFrameChars) return this.refenceLocally(connection, key, pool, checkpoint);
    const subscribers = this.subscribers.filter((subscriber) => subscriber.pools.has(key) && this.serves(subscriber, key));
    const charts = subscribers.filter((subscriber) => subscriber.request.migration);
    let parsed: ReturnType<typeof parseFrames>;
    try {
      parsed = parseFrames(wire, key, connection.expected, charts);
    } catch {
      return this.refenceLocally(connection, key, pool, checkpoint);
    }
    if (!parsed) return;
    const { frames, frame } = parsed;
    if (!frame) return passed(pool, checkpoint);
    if (!fresh(pool, frame, wire.summary)) return;
    // A listener may stop its subscription or replace the stream: later listeners then get nothing from this frame.
    const current = (subscriber: Subscriber) => this.connection === connection && connection.source !== null && pool.fence !== null && this.active.has(subscriber);
    for (const [subscriber, chartFrame] of frames) if (current(subscriber)) safely(() => subscriber.request.listener.frame?.(chartFrame, data.length));
    if (frame.type !== "trade") return;
    const trade: MarketTrade = { poolKey: key, checkpoint: frame.checkpoint, trade: frame.trade, summary: pool.summary };
    for (const subscriber of subscribers) if (current(subscriber)) safely(() => subscriber.request.listener.trade?.(trade));
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
      if (observer.coin === pool.coin && this.observers.has(observer) && current()) safely(() => observer.listener.trade(trade));
    }
  }

  /** `deadline`: the source missed a hello or heartbeat deadline. */
  private reconnect(deadline = false): void {
    const connection = this.connection;
    if (!connection?.source) return;
    const oldRelay = !deadline && connection.unavailableLast;
    this.hints?.disconnected();
    this.drop(deadline);
    this.socket = "reconnecting";
    const delay = oldRelay
      ? Math.round(Math.min(OLD_RELAY_MAX_MS, OLD_RELAY_WAIT_MS * 2 ** Math.min(this.oldRelayWaits++, 3)) * (1 + this.deps.random() / 2))
      : Math.round(Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempts++, 6) * (1 + this.deps.random() / 2)));
    this.cancelReconnect = this.deps.schedule(() => {
      this.cancelReconnect = null;
      if (this.connection !== connection) return;
      if (!this.deps.visible()) return this.pause();
      this.connect();
    }, delay);
    this.publish();
  }
}

let tab: MarketStreamHub | null = null;

/** The tab's hub; null outside a browser with WebSocket. */
export function tabMarketStream(): MarketStreamHub | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  if (tab) return tab;
  const schedule = (run: () => void, ms: number) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  };
  const timing = Math.random() < TIMING_SAMPLE_RATE
    ? createLiveTiming({
      now: Date.now,
      schedule,
      afterPaint: (run) => requestAnimationFrame(() => run()),
      visible: () => document.visibilityState === "visible",
      send: (path, body) => navigator.sendBeacon(path, body),
    })
    : null;
  return (tab = new MarketStreamHub({
    createSource: (url) => {
      const source = browserLiveSource(url, timing ? (socket) => timing.socket(socket) : undefined);
      if (timing) {
        source.addEventListener("market", ({ data }) => timing.market(data));
        source.addEventListener("pong", ({ data }) => timing.pong(data));
      }
      return source;
    },
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

/**
 * Tests only: closes the tab's stream now, without the linger, and forgets the hub, so a later test in
 * the same file opens its own socket instead of reusing the one an earlier test left lingering.
 */
export function resetTabMarketStream(): void {
  tab?.["close"](); // `close` stays private: nothing else may end the stream at once
  tab = null;
}
