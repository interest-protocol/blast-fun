import { hintOf } from "@blast/core/modules/live/hint-frames.ts";
import { presaleMarketFrameSchema } from "@blast/core/modules/live/presale-market-frames.ts";
import { ACTIVITY_HINT_STREAM_BUDGET } from "@blast/core/modules/backend-api/stream-budget.ts";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { EVENT_CURSOR, compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import {
  MARKET_STREAM_BUDGET as B,
  marketStreamPools,
  marketStreamActivity,
  marketStreamPriceCoins,
  marketStreamPresale,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import {
  deploymentMismatch,
  parseInfraProvenance,
  type ExpectedDeployment,
} from "@blast/core/modules/launchpad-contract/provenance.ts";
import {
  parseAtomic,
  parsePriceString,
  parseUsdString,
} from "@blast/core/modules/launchpad-contract/decimal.ts";
import type { WebSocket } from "undici";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { parseOpeningRound } from "@blast/core/modules/launchpad-contract/activity.ts";
import {
  DisplayPriceFeed,
  type DisplayPriceReader,
  type DisplayPriceSubscription,
} from "./display-price-feed.ts";
import type { HintSink } from "../../lib/hint-subscription.ts";

/** Only the upstream operations this read-only relay needs. */
export interface RelaySocket {
  send(text: string): void;
  close(): void;
  onmessage:
    | ((event: Parameters<NonNullable<WebSocket["onmessage"]>>[0]) => void)
    | null;
  onclose:
    | ((event: Parameters<NonNullable<WebSocket["onclose"]>>[0]) => void)
    | null;
  onerror:
    | ((event: Parameters<NonNullable<WebSocket["onerror"]>>[0]) => void)
    | null;
}

type Frame = Readonly<Record<string, unknown>>;
/** What one socket streams: a `set` replaces it whole. */
export type MarketSet = Readonly<{
  pools: readonly string[];
  priceCoins: readonly string[];
  presale: string | null;
}>;
/** A socket's handle: `set` changes its pools, coins and presale in place; kept pools keep their fence. */
export type MarketSubscription = Readonly<{
  stop(): void;
  set(next: MarketSet): void;
}>;
/** `set` mutates the pools, coins and presale; `activity` stays as the socket opened. */
type Client = {
  pools: readonly string[];
  priceCoins: readonly string[];
  activity: boolean;
  presale: string | null;
  prices?: DisplayPriceSubscription;
  sink: HintSink;
  stop: () => void;
};
type Topic = {
  clients: Set<Client>;
  fence?: Frame;
  cursor?: string;
  priceMissing?: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  /** Recent frames for browser resume; every frame after `floor` is here. */
  ring: { cursor: string; bytes: Uint8Array; at: number }[];
  ringBytes: number;
  floor?: string;
  /**
   * An upstream resume from `cursor` is in flight. The reader answers
   * `[replayed log frames…, resume_complete, snapshot]`; replayed frames carry
   * no summary or open candle, which only the trailing snapshot holds.
   */
  resuming?: boolean;
  /** A replayed frame arrived: the trailing snapshot is a new fence. Otherwise it is dropped. */
  resumeChanged?: boolean;
  /** A wait before the pool's next upstream subscribe, after a failed one; its frames are dropped meanwhile. */
  retry?: ReturnType<typeof setTimeout>;
  /** Re-fences since the last fence: picks the next wait from `RETRY_MS`. */
  attempt?: number;
  /** When the current fence was set: a fence that held `STABLE_MS` restarts the backoff. */
  fencedAt?: number;
  /** Its browsers were told `recovering`; the next fence ends it. */
  recovering?: boolean;
  /** The reader does not know the pool: its browsers were told `unavailable`. */
  missing?: boolean;
  /** The latest `coin_stats` (state, not log): sent after each fence, never in the ring. */
  stats?: { checkpoint: number; bytes: Uint8Array; unsent?: boolean };
};
/** Options for a direct socket subscriber. */
export type MarketSubscribeOptions = Readonly<{
  resume?: ReadonlyMap<string, string>;
}>;
/** How long, and how many frames, each pool keeps for browser resume. */
export const RESUME_RING = Object.freeze({ ms: 120_000, frames: 256, bytes: 65_536, replayBytes: 32_768 });
/** Upstream losses that keep browsers connected while the relay reconnects. */
const UPSTREAM_LOSS = new Set(["upstream-unavailable", "upstream-silent", "upstream-resync", "upstream-invalid", "handshake-timeout"]);
/** How long a pool subscribe waits for its fence before the pool re-fences. */
const FENCE_MS = 10_000;
/** Waits before a re-fencing pool subscribes again: at once, then 5 s, 10 s and every 30 s. */
const RETRY_MS = [0, 5_000, 10_000, 30_000] as const;
/** A fence or an upstream that held this long counts as recovered: its next fault starts the backoff over. */
const STABLE_MS = 60_000;
/** A pool the reader does not know is asked again this often. */
const MISSING_RETRY_MS = 60_000;
/** With no market progress for this long, browsers are told the stream is `stale`. */
const STALE_MS = 30_000;
/** While the upstream reconnects, browsers keep getting heartbeats this long, then fall back on their own. */
const LOSS_HEARTBEAT_MS = 30_000;
/** Ends every browser: a bad hello or another deployment's frame. Any other upstream fault is per pool or an upstream loss. */
class Fatal extends Error {}
const encoder = new TextEncoder();
const event = (name: string, value: unknown, id?: string) =>
  encoder.encode(
    `${id ? `id: ${id}\n` : ""}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`,
  );
const HEARTBEAT = event("heartbeat", {});
const object = (value: unknown): Frame => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid market frame.");
  return value as Frame;
};
const safeCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function withoutLabels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLabels);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "labels")
        .map(([key, item]) => [key, withoutLabels(item)]),
    );
  return value;
}

/** The relay's send time joins the engine's hop stamps (protocol.md section 4); frames without `hops`, or with all 8 keys used, pass unchanged. */
export function stampRelay(frame: unknown, now: number): unknown {
  const provenance = (frame as { provenance?: { hops?: unknown } }).provenance;
  const hops = provenance?.hops;
  if (!hops || typeof hops !== "object" || Array.isArray(hops) || Object.keys(hops).length >= 8) return frame;
  return { ...(frame as object), provenance: { ...provenance, hops: { ...hops, relay_ms: now } } };
}

function marketPool(frame: Frame): string {
  let pool: unknown;
  if (frame.type === "snapshot") {
    if (typeof frame.topic !== "string" || !frame.topic.startsWith("pool:"))
      throw new Error();
    pool = frame.topic.slice(5);
  } else
    pool =
      frame.type === "trade" ? object(frame.trade).pool_key : frame.pool_key;
  if (typeof pool !== "string" || !POOL_KEY.test(pool))
    throw new Error();
  return pool;
}

function validateEnvelope(frame: Frame, expected: ExpectedDeployment): string {
  const provenance = parseInfraProvenance(frame.provenance);
  if (
    !safeCount(frame.checkpoint) ||
    !safeCount(frame.timestamp_ms) ||
    provenance.checkpoint !== frame.checkpoint ||
    provenance.timestampMs !== frame.timestamp_ms ||
    typeof frame.cursor !== "string" ||
    !EVENT_CURSOR.test(frame.cursor)
  )
    throw new Error();
  if (deploymentMismatch(provenance, expected)) throw new Fatal();
  const checkpoint = BigInt(frame.cursor.split(":")[0]!);
  if (
    frame.type === "snapshot"
      ? checkpoint > BigInt(frame.checkpoint as number)
      : checkpoint !== BigInt(frame.checkpoint as number)
  )
    throw new Error();
  return frame.cursor;
}

function validateTrade(frame: Frame): void {
  const trade = object(frame.trade);
  if (
    typeof trade.cursor !== "string" ||
    !EVENT_CURSOR.test(trade.cursor) ||
    trade.checkpoint !== frame.checkpoint ||
    trade.timestamp_ms !== frame.timestamp_ms ||
    !["buy", "sell"].includes(String(trade.side))
  )
    throw new Error();
  if (
    trade.cursor.split(":").slice(0, 3).join(":") !==
      String(frame.cursor).split(":").slice(0, 3).join(":") ||
    compareEventCursors(trade.cursor, String(frame.cursor)) > 0 ||
    !["pre_share_buy", "buy", "sell", "opening_round", "swap"].includes(
      String(trade.kind),
    )
  )
    throw new Error();
  if (trade.price !== null) parsePriceString(trade.price, "trade.price");
  parseAtomic(trade.quote_amount, "trade.quote_amount", 128);
  parseAtomic(trade.meme_amount, "trade.meme_amount", 128);
  if (trade.volume_usd !== null)
    parseUsdString(trade.volume_usd, "trade.volume_usd");
}

function validateCandle(frame: Frame): void {
  const candle = object(frame.candle);
  if (
    !safeCount(candle.bucket_start) ||
    frame.interval !== candle.interval ||
    !["1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w"].includes(
      String(frame.interval),
    )
  )
    throw new Error();
  for (const field of ["open", "high", "low", "close"])
    parsePriceString(candle[field], `candle.${field}`);
  for (const field of ["volume_quote", "volume_meme"])
    parseAtomic(candle[field], `candle.${field}`, 128);
  for (const field of ["buys", "sells", "trades"])
    if (!safeCount(candle[field])) throw new Error();
  if (candle.volume_usd !== null)
    parseUsdString(candle.volume_usd, "candle.volume_usd");
}

/** One private market socket per process; subscription and downstream byte budgets are finite. */
function parseSubscription(request: Request): { pools: readonly string[]; priceCoins: readonly string[]; presale: string | null } | null {
  try {
    return { pools: marketStreamPools(request), priceCoins: marketStreamPriceCoins(request), presale: marketStreamPresale(request) };
  } catch {
    return null;
  }
}

/** Whether the frame's latest trade lacks a price; undefined when the frame says nothing about it. */
function priceMissing(frame: Frame): boolean | undefined {
  if (frame.type === "snapshot" && Array.isArray(frame.trades)) {
    const latest = frame.trades.map(object).find((trade) => trade.kind !== "opening_round_fill");
    return latest !== undefined && latest.price == null;
  }
  if (frame.type === "trade") return object(frame.trade).price === null;
  return undefined;
}

type FencePoint = Readonly<{ checkpoint: unknown; cursor: string; provenance: unknown }>;

/** The `status: live` block a pool's browsers get: every later frame follows this cursor. */
function fenceStatus(pool: string, at: FencePoint, priceMissing?: boolean): Frame {
  return {
    state: "live",
    pool_key: pool,
    checkpoint: at.checkpoint,
    cursor: at.cursor,
    provenance: at.provenance,
    ...(priceMissing ? { price_missing: true } : {}),
  };
}

function validateMarketBody(frame: Frame): void {
  if (frame.type === "trade") validateTrade(frame);
  if (frame.type === "candle_closed") validateCandle(frame);
  if (frame.type === "opening_round") parseOpeningRound(frame.opening_round, "opening_round");
}

export class MarketStreamRelay {
  readonly #connect: () => RelaySocket;
  readonly #expected: ExpectedDeployment;
  readonly #prices?: DisplayPriceFeed;
  /** Live sockets; the process's configured stream count. */
  readonly #maxClients: number;
  readonly #topics = new Map<string, Topic>();
  readonly #presales = new Map<string, Set<Client>>();
  readonly #clients = new Set<Client>();
  #socket: RelaySocket | null = null;
  #ready = false;
  #hello: Frame | null = null;
  #hintReady = false;
  #presaleCheckpoint: number | null = null;
  #feedPending = false;
  #pongDeadline?: ReturnType<typeof setTimeout>;
  #handshake?: ReturnType<typeof setTimeout>;
  #heartbeat?: ReturnType<typeof setInterval>;
  #ending = false;
  #reopen?: ReturnType<typeof setTimeout>;
  #reopenAttempt = 0;
  /** Pools whose upstream resume is in flight, in the order the reader answers them. */
  #resumes: string[] = [];
  /** The highest `market_checkpoint` a pong carried on this socket; a reader that sends none never makes the stream `stale`. */
  #marketCheckpoint: number | null = null;
  #progressAt = 0;
  #stale = false;
  /** When the upstream was lost; cleared once a new one is ready. */
  #lostAt?: number;
  /** When this upstream said hello: one that held `STABLE_MS` restarts the reconnect backoff. */
  #readyAt = 0;
  /** The hello subscribe (activity and pools) is unanswered: a topic-less error before the first pong is its refusal. */
  #helloPending = false;

  constructor(
    connect: () => RelaySocket,
    expected: ExpectedDeployment,
    prices?: DisplayPriceReader,
    maxClients: number = ACTIVITY_HINT_STREAM_BUDGET.maxClients,
  ) {
    this.#connect = connect;
    this.#maxClients = maxClients;
    this.#expected = expected;
    if (prices) this.#prices = new DisplayPriceFeed(prices);
  }

  /** Whether a new socket for these pools and coins fits the shared tables now; it never fills them silently. */
  admits(pools: readonly string[], priceCoins: readonly string[]): boolean {
    return this.#clients.size < this.#maxClients && this.fits(pools, priceCoins);
  }

  /** Whether an open socket may add these pools and coins: the pool and coin tables only, as it is already a client. */
  fits(pools: readonly string[], priceCoins: readonly string[]): boolean {
    const added = pools.filter((pool) => !this.#topics.has(pool)).length;
    return this.#topics.size + added <= B.maxTopics && (this.#prices?.admits(priceCoins) ?? true);
  }

  subscribe(request: Request, sink: HintSink, options: MarketSubscribeOptions = {}): Response | MarketSubscription {
    const parsed = parseSubscription(request);
    if (!parsed) {
      return publicErrorResponse(
        "invalid_parameter",
        "Invalid subscription to market pools or coin prices.",
        400,
      );
    }
    const { pools, priceCoins, presale } = parsed;
    const added = pools.filter((pool) => !this.#topics.has(pool));
    if (
      this.#clients.size >= this.#maxClients ||
      this.#topics.size + added.length > B.maxTopics
    )
      return publicErrorResponse(
        "service_unavailable",
        "Market streaming is busy. Please retry.",
        503,
        { headers: { "Retry-After": "5" } },
      );
    const client: Client = {
      pools: [],
      priceCoins: [],
      activity: marketStreamActivity(request) || presale !== null,
      presale: null,
      sink,
      stop: () => {
        if (!this.#clients.delete(client)) return;
        client.prices?.stop();
        this.#leavePresale(client);
        this.#releaseTopics(client, client.pools);
        sink.close();
        if (!this.#clients.size) this.#disconnect();
      },
    };
    this.#clients.add(client);
    this.#setPrices(client, priceCoins);
    this.#joinPresale(client, presale);
    this.#send(client, event("status", { state: "connecting" }));
    this.#joinTopics(client, pools, options.resume);
    this.#greetHints(client);
    const subscription = { stop: client.stop, set: (next: MarketSet) => this.#set(client, next) };
    // A refused send already dropped the client: start nothing for it.
    if (!this.#clients.has(client)) return subscription;
    if (!this.#heartbeat) this.#heartbeat = setInterval(() => this.#beat(), B.heartbeatMs);
    if (!this.#socket && !this.#reopen) this.#open();
    else this.#subscribeFresh(added);
    return subscription;
  }

  /**
   * Replaces what one socket streams. Removed pools leave (upstream `unsubscribe` when last);
   * added ones join and catch up, and a pool new to the process is subscribed upstream now, or on
   * the next hello while the upstream is away. Kept pools are untouched. The caller checked `fits`.
   */
  #set(client: Client, next: MarketSet): void {
    if (!this.#clients.has(client)) return;
    const removed = client.pools.filter((pool) => !next.pools.includes(pool));
    const added = next.pools.filter((pool) => !client.pools.includes(pool));
    this.#releaseTopics(client, removed);
    // A failed upstream `unsubscribe` ends the session; a refused `recovering` stops this client.
    if (!this.#clients.has(client)) return;
    this.#setPrices(client, next.priceCoins);
    if (next.presale !== client.presale) {
      this.#leavePresale(client);
      this.#joinPresale(client, next.presale);
      if (next.presale && client.activity && this.#hintReady) this.#send(client, event("hint", this.#hintPong(true)));
    }
    const fresh = added.filter((pool) => !this.#topics.has(pool));
    this.#joinTopics(client, added);
    this.#subscribeFresh(fresh);
  }

  /** Upstream `subscribe` for pools new to the process that still have a topic: a client dropped while joining left none. */
  #subscribeFresh(pools: readonly string[]): void {
    const live = pools.filter((pool) => this.#topics.has(pool));
    if (this.#ready && live.length) this.#subscribe("subscribe", live);
  }

  /** Changes the coin list in place: a restart would resend kept coins and could abort the shared read. */
  #setPrices(client: Client, coins: readonly string[]): void {
    client.priceCoins = coins;
    if (!this.#prices) return;
    if (!coins.length) {
      client.prices?.stop();
      client.prices = undefined;
    } else if (client.prices) client.prices.update(coins);
    else client.prices = this.#prices.subscribe(coins, (frame) => this.#send(client, event("prices", frame)));
  }

  #joinPresale(client: Client, presale: string | null): void {
    client.presale = presale;
    if (!presale) return;
    const clients = this.#presales.get(presale) ?? new Set<Client>();
    clients.add(client);
    this.#presales.set(presale, clients);
  }

  #leavePresale(client: Client): void {
    const presale = client.presale;
    client.presale = null;
    if (!presale) return;
    const clients = this.#presales.get(presale);
    clients?.delete(client);
    if (!clients?.size) this.#presales.delete(presale);
  }

  #greetHints(client: Client): void {
    if (!client.activity || !this.#hello) return;
    this.#send(client, event("hint", this.#hello));
    if (this.#hintReady) this.#send(client, event("hint", this.#hintPong(client.presale !== null)));
  }

  /** Each catch-up can drop the client (its sink refused); then it joins nothing more. */
  #joinTopics(client: Client, pools: readonly string[], resume?: ReadonlyMap<string, string>): void {
    for (const pool of pools) {
      if (!this.#clients.has(client)) return;
      client.pools = [...client.pools, pool];
      let topic = this.#topics.get(pool);
      if (!topic) {
        topic = { clients: new Set(), ring: [], ringBytes: 0 };
        this.#topics.set(pool, topic);
      }
      topic.clients.add(client);
      this.#catchUp(client, pool, topic, resume?.get(pool));
    }
  }

  /** A joining browser gets the pool's fence and what it missed, or `recovering` while the pool has none. */
  #catchUp(client: Client, pool: string, topic: Topic, cursor: string | undefined): void {
    if (!topic.fence) {
      if (topic.recovering) this.#send(client, event("status", { state: "recovering", pool_key: pool }));
      return;
    }
    const missed = this.#missed(topic, cursor);
    if (missed) {
      // The ring holds every frame after the browser's cursor: keep its state, send only what it missed.
      this.#send(client, event("status", { ...topic.fence, cursor: missed.from, resumed: true }));
      for (const frame of missed.frames) this.#send(client, frame.bytes);
    } else this.#send(client, event("status", topic.fence));
    if (topic.stats) this.#send(client, topic.stats.bytes);
  }

  /** Latest wins by checkpoint; its cursor may precede trades it already counts, so it skips the cursor order. */
  #stats(topic: Topic, frame: Frame): void {
    if (typeof frame.coin !== "string" || frame.coin.length > 320) throw new Error();
    if (topic.stats && (frame.checkpoint as number) < topic.stats.checkpoint) return;
    const bytes = event("stats", stampRelay(withoutLabels(frame), Date.now()));
    if (bytes.byteLength > B.maxChunkBytes) return;
    const send = topic.fence !== undefined && !topic.resuming;
    // Held during a resume: the trailing snapshot sends it, or #endResume does when nothing changed.
    topic.stats = { checkpoint: frame.checkpoint as number, bytes, unsent: !send };
    if (send) for (const client of topic.clients) this.#send(client, bytes);
  }

  #releaseTopics(client: Client, pools: readonly string[]): void {
    client.pools = client.pools.filter((pool) => !pools.includes(pool));
    for (const pool of pools) {
      const topic = this.#topics.get(pool);
      if (!topic) continue;
      topic.clients.delete(client);
      if (!topic.clients.size) {
        clearTimeout(topic.deadline);
        clearTimeout(topic.retry);
        this.#topics.delete(pool);
        if (this.#ready && !this.#ending) this.#subscribe("unsubscribe", [pool]);
      }
    }
  }

  #send(client: Client, data: Uint8Array): void {
    if (!this.#clients.has(client)) return;
    if (data.byteLength > B.maxChunkBytes || !client.sink.send(data)) {
      client.stop();
    }
  }

  #beat(): void {
    if (!this.#ready) {
      // Old browsers reconnect after a 9 s heartbeat silence: keep them for a short upstream loss.
      if (this.#lostAt !== undefined && Date.now() - this.#lostAt < LOSS_HEARTBEAT_MS)
        for (const client of this.#clients) this.#send(client, HEARTBEAT);
      return;
    }
    try {
      this.#ping();
    } catch {
      this.#end("upstream-unavailable");
    }
  }

  #ping(): void {
    if (!this.#socket || this.#pongDeadline !== undefined) return;
    // A ping during handshake can land just before an interval tick.
    this.#pongDeadline = setTimeout(() => this.#end("upstream-silent"), 2 * B.heartbeatMs);
    this.#socket.send(JSON.stringify({ op: "ping" }));
  }

  #subscribe(
    op: "subscribe" | "unsubscribe",
    pools: readonly string[],
    includeActivity = false,
  ): void {
    try {
      let topics: string[] = [];
      for (const topic of [
        ...(includeActivity ? ["activity"] : []),
        ...pools.map((pool) => `pool:${pool}`),
      ]) {
        if (
          encoder.encode(JSON.stringify({ op, topics: [...topics, topic] }))
            .byteLength > 4_096
        ) {
          this.#socket?.send(JSON.stringify({ op, topics }));
          topics = [];
        }
        topics.push(topic);
      }
      if (topics.length) this.#socket?.send(JSON.stringify({ op, topics }));
      // The snapshot deadline runs from the upstream subscribe, never from a pending handshake.
      if (op === "subscribe")
        for (const pool of pools) {
          const topic = this.#topics.get(pool);
          if (topic && !topic.fence && !topic.deadline) {
            topic.deadline = setTimeout(() => this.#refence(pool), FENCE_MS);
          }
        }
    } catch {
      this.#end("upstream-unavailable");
    }
  }

  #open(): void {
    try {
      const socket = this.#connect();
      this.#socket = socket;
      this.#handshake = setTimeout(
        () => this.#end("handshake-timeout"),
        10_000,
      );
      socket.onclose = socket.onerror = () => {
        if (this.#socket === socket) this.#end("upstream-unavailable");
      };
      socket.onmessage = ({ data }) => {
        if (this.#socket === socket) this.#receive(socket, data);
      };
    } catch {
      this.#end("upstream-unavailable");
    }
  }

  #receive(socket: RelaySocket, data: unknown): void {
    try {
      if (typeof data !== "string" || data.length > B.maxUpstreamFrameChars)
        throw new Error();
      const frame = object(JSON.parse(data));
      if (this.#control(socket, frame)) return;
      if (!this.#ready) throw new Error();
      this.#market(frame);
    } catch (error) {
      // A frame no pool can be blamed for drops the upstream only; browsers stay.
      this.#end(error instanceof Fatal ? "contract-violation" : "upstream-invalid");
    }
  }

  #control(socket: RelaySocket, frame: Frame): boolean {
    switch (frame.type) {
      case "hello":
        this.#greet(frame);
        return true;
      case "pong":
        this.#pong(socket, frame);
        return true;
      case "resume_complete":
        // The pool's trailing snapshot ends its resume (`#market`); its deadline runs until then.
        this.#resumes.shift();
        return true;
      case "error":
        this.#error(frame);
        return true;
      case "snapshot_unavailable":
        this.#snapshotUnavailable(frame);
        return true;
      case "resync_required":
        // `too_old` answers one resume; the connection stays open.
        if (frame.reason === "too_old" && this.#resumes.length) {
          this.#resumeFailed(this.#resumes.shift()!);
          return true;
        }
        this.#end("upstream-resync");
        return true;
      case "reconnect":
        this.#end("upstream-resync");
        return true;
      case "activity":
      case "presale_lifecycle":
      case "metadata":
        this.#activity(frame);
        return true;
      case "presale_trade":
      case "presale_pool_swap":
        this.#presale(frame);
        return true;
      default:
        return false;
    }
  }

  #greet(frame: Frame): void {
    if (
      this.#ready ||
      frame.protocol !== 1 ||
      deploymentMismatch(parseInfraProvenance(frame.provenance), this.#expected)
    )
      throw new Fatal();
    this.#ready = true;
    this.#hello = { type: "hello", provenance: frame.provenance, heartbeat: true, heartbeat_ms: B.heartbeatMs, set: true };
    this.#hint(this.#hello);
    this.#readyAt = Date.now();
    const fenced = [...this.#topics].filter(([, topic]) => topic.resuming && topic.cursor);
    // Resumes go first: the reader answers in order, so an `error` while resumes are pending is a resume's.
    for (const [pool, topic] of fenced) {
      if (!this.#socket) return;
      this.#resume(pool, topic);
    }
    this.#subscribe("subscribe", [...this.#topics].filter(([, topic]) => !topic.resuming || !topic.cursor).map(([pool]) => pool), true);
    if (!this.#socket) return;
    this.#helloPending = true;
    this.#ping();
  }

  #pong(socket: RelaySocket, frame: Frame): void {
    if (!this.#ready) throw new Error();
    if (this.#pongDeadline === undefined) return;
    clearTimeout(this.#pongDeadline);
    this.#pongDeadline = undefined;
    this.#pongProgress(frame.market_checkpoint);
    // The reader answers in order: the hello subscribe was taken.
    this.#helloPending = false;
    if (this.#reopenAttempt && Date.now() - this.#readyAt >= STABLE_MS) this.#reopenAttempt = 0;
    if (this.#hintReady) {
      this.#feedPending = false;
      // Confirm the upstream is alive before resetting the browser's deadline.
      for (const client of this.#clients) this.#send(client, HEARTBEAT);
      return;
    }
    if (safeCount(frame.activity_checkpoint)) {
      this.#presaleCheckpoint = Math.max(this.#presaleCheckpoint ?? -1, Number(frame.activity_checkpoint));
    }
    this.#hintReady = true;
    clearTimeout(this.#handshake);
    this.#handshake = undefined;
    if (this.#lostAt !== undefined) {
      this.#lostAt = undefined;
      this.#broadcast({ state: "fresh" });
    }
    const pong = event("hint", this.#hintPong(false));
    const presalePong = event("hint", this.#hintPong(true));
    for (const client of this.#clients)
      if (client.activity) this.#send(client, client.presale ? presalePong : pong);
    this.#feedPending = true;
    socket.send(JSON.stringify({ op: "subscribe", topics: ["feed"] }));
    this.#ping();
  }

  #hintPong(presale: boolean): Frame {
    return {
      type: "pong",
      ...(presale && this.#presaleCheckpoint !== null ? { presale_checkpoint: this.#presaleCheckpoint } : {}),
    };
  }

  #activity(frame: Frame): void {
    if (!this.#hintReady) return;
    const hint = hintOf(frame);
    if (hint) this.#hint(hint);
  }

  #presale(frame: Frame): void {
    const parsed = presaleMarketFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    const checkpoint = Number(parsed.data.cursor.split(":", 1)[0]);
    if (!Number.isSafeInteger(checkpoint)) return;
    this.#presaleCheckpoint = Math.max(this.#presaleCheckpoint ?? -1, checkpoint);
    const clients = this.#presales.get(parsed.data.presale_id);
    if (!this.#hintReady || !clients?.size) return;
    const bytes = event("presale", parsed.data);
    for (const client of clients) this.#send(client, bytes);
  }

  #market(frame: Frame): void {
    if (
      !["snapshot", "trade", "candle_closed", "lifecycle", "opening_round", "coin_stats"].includes(
        String(frame.type),
      )
    )
      return;
    const pool = marketPool(frame);
    const topic = this.#topics.get(pool);
    // An unsubscribe can race with already queued, still valid upstream frames.
    if (!topic || topic.retry) return;
    try {
      this.#poolFrame(pool, topic, frame);
    } catch (error) {
      if (error instanceof Fatal) throw error;
      // A bad frame for one pool: drop it and fence that pool again; every other pool streams on.
      this.#refence(pool);
    }
  }

  #poolFrame(pool: string, topic: Topic, frame: Frame): void {
    const cursor = validateEnvelope(frame, this.#expected);
    this.#marketProgress();
    if (frame.type === "coin_stats") return this.#stats(topic, frame);
    if (topic.resuming && !this.#endResume(topic, frame, cursor)) return;
    // The reader snapshots every pool it streams: a frame before the snapshot is in it.
    if (frame.type !== "snapshot" && !topic.fence) return;
    if (topic.cursor && compareEventCursors(cursor, topic.cursor) < 0)
      throw new Error();
    validateMarketBody(frame);
    if (
      topic.cursor &&
      frame.type !== "snapshot" &&
      compareEventCursors(cursor, topic.cursor) === 0
    )
      return;
    this.#deliver(pool, topic, frame, cursor);
  }

  /** True when a resuming pool's frame should be delivered: only a snapshot after a change while away. */
  #endResume(topic: Topic, frame: Frame, cursor: string): boolean {
    if (frame.type !== "snapshot") {
      // Replayed frames lack their state; the browser gets them through the snapshot's new fence.
      if (!topic.cursor || compareEventCursors(cursor, topic.cursor) > 0) topic.resumeChanged = true;
      return false;
    }
    const changed = topic.resumeChanged;
    clearTimeout(topic.deadline);
    Object.assign(topic, { deadline: undefined, resuming: false, resumeChanged: false });
    if (changed === true) return true;
    // Nothing happened to the pool while upstream was away: browsers keep their fence and ring.
    if (topic.stats?.unsent) for (const client of topic.clients) this.#send(client, topic.stats.bytes);
    if (topic.stats) topic.stats.unsent = false;
    return false;
  }

  /** Fences the pool at a snapshot's cursor and tells its clients. */
  #fence(pool: string, topic: Topic, at: FencePoint): void {
    clearTimeout(topic.retry);
    Object.assign(topic, { retry: undefined, recovering: false, missing: false, fencedAt: Date.now() });
    topic.cursor = at.cursor;
    topic.fence = fenceStatus(pool, at, topic.priceMissing);
    clearTimeout(topic.deadline);
    topic.deadline = undefined;
    topic.ring = [];
    topic.ringBytes = 0;
    topic.floor = at.cursor;
    if (topic.stats) topic.stats.unsent = false;
    for (const client of topic.clients) {
      this.#send(client, event("status", topic.fence));
      if (topic.stats) this.#send(client, topic.stats.bytes);
    }
  }

  #deliver(pool: string, topic: Topic, frame: Frame, cursor: string): void {
    topic.priceMissing = priceMissing(frame) ?? topic.priceMissing;
    const at = { checkpoint: frame.checkpoint, cursor, provenance: frame.provenance };
    if (frame.type === "snapshot") this.#fence(pool, topic, at);
    else {
      topic.cursor = cursor;
      topic.fence = fenceStatus(pool, at, topic.priceMissing);
      const bytes = event("market", stampRelay(withoutLabels(frame), Date.now()), cursor);
      if (bytes.byteLength > B.maxChunkBytes) throw new Error("frame-too-large");
      this.#remember(topic, cursor, bytes);
      for (const client of topic.clients) this.#send(client, bytes);
    }
  }

  #remember(topic: Topic, cursor: string, bytes: Uint8Array): void {
    const now = Date.now();
    topic.ring.push({ cursor, bytes, at: now });
    topic.ringBytes += bytes.byteLength;
    while (
      topic.ring.length > RESUME_RING.frames ||
      topic.ringBytes > RESUME_RING.bytes ||
      topic.ring[0]!.at < now - RESUME_RING.ms
    ) {
      const dropped = topic.ring.shift()!;
      topic.ringBytes -= dropped.bytes.byteLength;
      topic.floor = dropped.cursor;
    }
  }

  /** The frames after `from` if the ring holds all of them and they fit one replay; else null. */
  #missed(topic: Topic, from: string | undefined) {
    if (!from || !topic.floor || !topic.cursor) return null;
    if (compareEventCursors(from, topic.floor) < 0 || compareEventCursors(from, topic.cursor) > 0) return null;
    const frames = topic.ring.filter((frame) => compareEventCursors(frame.cursor, from) > 0);
    const bytes = frames.reduce((total, frame) => total + frame.bytes.byteLength, 0);
    return bytes > RESUME_RING.replayBytes ? null : { from, frames };
  }

  /** Resume one fenced pool from its cursor; the reader answers each cursor subscribe in order. */
  #resume(pool: string, topic: Topic): void {
    try {
      this.#socket?.send(JSON.stringify({ op: "subscribe", topics: [`pool:${pool}`], cursor: topic.cursor }));
      this.#resumes.push(pool);
      topic.deadline = setTimeout(() => this.#refence(pool), FENCE_MS);
    } catch {
      this.#end("upstream-unavailable");
    }
  }

  /**
   * The pool lost its fence (no fence in time, a failed or too old resume, a bad frame, or the
   * reader could not snapshot it): its browsers are told `recovering` and keep their socket, and
   * the relay subscribes it fresh after a backoff. The next snapshot fences it
   * again, and browsers refetch history on the new fence. Unsubscribing first makes a reader that
   * already holds the topic send a new snapshot.
   */
  #refence(pool: string): void {
    const stable = this.#topics.get(pool)?.fencedAt;
    const topic = this.#unfence(pool);
    if (!topic) return;
    if (stable !== undefined && Date.now() - stable >= STABLE_MS) topic.attempt = 0;
    // A pool the reader knows again: a later `not_found` tells browsers `unavailable` again.
    topic.missing = false;
    if (!topic.recovering) {
      topic.recovering = true;
      this.#tell(topic, { state: "recovering", pool_key: pool });
    }
    const attempt = topic.attempt ?? 0;
    topic.attempt = attempt + 1;
    this.#retry(pool, topic, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
  }

  /** The reader refused a pool's resume; it may already be re-fencing for another reason. */
  #resumeFailed(pool: string): void {
    if (this.#topics.get(pool)?.resuming) this.#refence(pool);
  }

  /** The reader does not know the pool: only its browsers are told, and it is asked again later. */
  #missing(pool: string): void {
    const topic = this.#unfence(pool);
    if (!topic) return;
    topic.recovering = false;
    if (!topic.missing) {
      topic.missing = true;
      this.#tell(topic, { state: "unavailable", pool_key: pool });
    }
    this.#retry(pool, topic, MISSING_RETRY_MS);
  }

  /**
   * Drops the pool's fence and its timers. A pending resume stays in `#resumes` until the reader
   * answers it, so later answers still pair with their own pools.
   */
  #unfence(pool: string): Topic | undefined {
    const topic = this.#topics.get(pool);
    if (!topic) return undefined;
    clearTimeout(topic.deadline);
    clearTimeout(topic.retry);
    Object.assign(topic, {
      deadline: undefined, retry: undefined, fence: undefined, cursor: undefined, floor: undefined,
      ring: [], ringBytes: 0, resuming: false, resumeChanged: false, priceMissing: undefined, fencedAt: undefined,
    });
    return topic;
  }

  /** Frees the reader's topic now and subscribes again after `wait`; an upstream loss re-subscribes it on hello instead. */
  #retry(pool: string, topic: Topic, wait: number): void {
    if (!this.#ready) return;
    this.#subscribe("unsubscribe", [pool]);
    topic.retry = setTimeout(() => {
      topic.retry = undefined;
      if (this.#ready && this.#topics.get(pool) === topic) this.#subscribe("subscribe", [pool]);
    }, wait);
  }

  /**
   * An `error`. One naming its topics answers those topics. Without topics (an older reader) it
   * answers the feed subscribe, then the oldest pending resume; a `not_ready` one answers the
   * pool subscribes still waiting for a fence. Anything else reconnects the upstream.
   */
  #error(frame: Frame): void {
    if (Array.isArray(frame.topics)) return this.#topicsError(frame.topics);
    if (this.#feedPending) {
      this.#feedPending = false;
      return;
    }
    if (this.#resumes.length) return this.#resumeFailed(this.#resumes.shift()!);
    // A refused hello subscribe carried activity as well as pools.
    if (this.#helloPending) return this.#end("upstream-resync");
    const error = frame.error;
    if (error && typeof error === "object" && (error as Frame).code === "not_ready") {
      for (const [pool, topic] of this.#topics) if (!topic.fence && topic.deadline !== undefined) this.#refence(pool);
      return;
    }
    this.#end("upstream-resync");
  }

  #topicsError(topics: unknown[]): void {
    // Activity has no per-topic retry: only a new upstream subscribes it again.
    if (topics.includes("activity")) return this.#end("upstream-resync");
    for (const topic of topics) {
      if (topic === "feed") this.#feedPending = false;
      else if (typeof topic === "string" && topic.startsWith("pool:")) this.#poolError(topic.slice(5));
    }
  }

  /** The error answers that pool's resume, if one is pending. */
  #poolError(pool: string): void {
    const index = this.#resumes.indexOf(pool);
    if (index >= 0) this.#resumes.splice(index, 1);
    this.#refence(pool);
  }

  /** The reader could not snapshot one pool: `not_found` means it does not know it; otherwise try again. */
  #snapshotUnavailable(frame: Frame): void {
    if (typeof frame.topic !== "string" || !frame.topic.startsWith("pool:")) return;
    const pool = frame.topic.slice(5);
    if (frame.reason === "not_found") this.#missing(pool);
    else this.#refence(pool);
  }

  /**
   * Market progress: any market frame, or a pong whose `market_checkpoint` rose. After `STALE_MS`
   * without it, browsers are told the stream is `stale`, and `fresh` once it moves. Only a reader
   * whose pongs carry `market_checkpoint` can make the stream stale: a quiet market is not a fault.
   */
  #marketProgress(): void {
    this.#progressAt = Date.now();
    if (!this.#stale) return;
    this.#stale = false;
    this.#broadcast({ state: "fresh" });
  }

  #pongProgress(checkpoint: unknown): void {
    if (safeCount(checkpoint) && (this.#marketCheckpoint === null || (checkpoint as number) > this.#marketCheckpoint)) {
      this.#marketCheckpoint = checkpoint as number;
      return this.#marketProgress();
    }
    if (this.#marketCheckpoint === null || this.#stale || Date.now() - this.#progressAt <= STALE_MS) return;
    this.#stale = true;
    this.#broadcast({ state: "stale" });
  }

  #tell(topic: Topic, status: Frame): void {
    const bytes = event("status", status);
    for (const client of topic.clients) this.#send(client, bytes);
  }

  #broadcast(status: Frame): void {
    const bytes = event("status", status);
    for (const client of this.#clients) this.#send(client, bytes);
  }

  #hint(frame: Frame): void {
    const bytes = event("hint", frame);
    // A hint is a signal: an oversized one is dropped, never the stream.
    if (bytes.byteLength > ACTIVITY_HINT_STREAM_BUDGET.maxChunkBytes) return;
    for (const client of this.#clients)
      if (client.activity) this.#send(client, bytes);
  }

  #end(reason: string): void {
    if (UPSTREAM_LOSS.has(reason) && this.#clients.size) return this.#lose();
    this.#ending = true;
    for (const client of [...this.#clients]) {
      this.#send(client, event("resync", { reason }));
      client.stop();
    }
    this.#disconnect();
    this.#ending = false;
  }

  /**
   * The upstream dropped: browsers stay connected, are told `recovering` (and `fresh` once a new
   * upstream is ready) and keep their heartbeat for `LOSS_HEARTBEAT_MS`, while the relay
   * reconnects and resumes every fenced pool from its cursor.
   */
  #lose(): void {
    if (this.#lostAt === undefined) {
      this.#lostAt = Date.now();
      this.#broadcast({ state: "recovering" });
    }
    for (const topic of this.#topics.values()) {
      clearTimeout(topic.deadline);
      clearTimeout(topic.retry);
      topic.deadline = undefined;
      topic.retry = undefined;
      topic.resumeChanged = false;
      topic.resuming = topic.fence !== undefined;
    }
    this.#closeUpstream();
    const delay = Math.min(5_000, 250 * 2 ** this.#reopenAttempt++) * (1 + Math.random() / 2);
    this.#reopen = setTimeout(() => {
      this.#reopen = undefined;
      if (!this.#clients.size) return;
      this.#open();
    }, delay);
  }

  #disconnect(): void {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#reopen);
    this.#heartbeat = undefined;
    this.#reopen = undefined;
    this.#reopenAttempt = 0;
    for (const topic of this.#topics.values()) {
      clearTimeout(topic.deadline);
      clearTimeout(topic.retry);
    }
    this.#topics.clear();
    this.#lostAt = undefined;
    this.#closeUpstream();
  }

  #closeUpstream(): void {
    clearTimeout(this.#handshake);
    this.#handshake = undefined;
    this.#resumes = [];
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#hello = null;
    this.#hintReady = false;
    this.#presaleCheckpoint = null;
    this.#feedPending = false;
    this.#marketCheckpoint = null;
    this.#stale = false;
    this.#helloPending = false;
    clearTimeout(this.#pongDeadline);
    this.#pongDeadline = undefined;
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
  }
}
