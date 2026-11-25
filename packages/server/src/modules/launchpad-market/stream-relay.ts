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
import type { RelaySocket } from "../social/activity/hint-relay.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { parseOpeningRound } from "@blast/core/modules/launchpad-contract/activity.ts";
import { DisplayPriceFeed, type DisplayPriceReader } from "./display-price-feed.ts";
import { hintWebResponse, type HintSink, type HintSubscription } from "../../lib/hint-subscription.ts";

type Frame = Readonly<Record<string, unknown>>;
type Client = {
  pools: readonly string[];
  activity: boolean;
  presale: string | null;
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
  /** The latest `coin_stats` (state, not log): sent after each fence, never in the ring. */
  stats?: { checkpoint: number; bytes: Uint8Array; unsent?: boolean };
};
/** Options for a direct socket subscriber. SSE keeps its finite lifetime and never resumes. */
export type MarketSubscribeOptions = Readonly<{
  resume?: ReadonlyMap<string, string>;
  lifetime?: boolean;
}>;
/** How long, and how many frames, each pool keeps for browser resume. */
export const RESUME_RING = Object.freeze({ ms: 120_000, frames: 256, bytes: 65_536, replayBytes: 32_768 });
/** Upstream losses that keep browsers connected while the relay reconnects. */
const UPSTREAM_LOSS = new Set(["upstream-unavailable", "upstream-silent", "upstream-resync", "handshake-timeout"]);
const encoder = new TextEncoder();
export const MARKET_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "private, no-store",
  "x-accel-buffering": "no",
} as const;
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
    deploymentMismatch(provenance, expected) ||
    typeof frame.cursor !== "string" ||
    !EVENT_CURSOR.test(frame.cursor)
  )
    throw new Error();
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

function validateMarketBody(frame: Frame): void {
  if (frame.type === "trade") validateTrade(frame);
  if (frame.type === "candle_closed") validateCandle(frame);
  if (frame.type === "opening_round") parseOpeningRound(frame.opening_round, "opening_round");
}

export class MarketStreamRelay {
  readonly #connect: () => RelaySocket;
  readonly #expected: ExpectedDeployment;
  readonly #prices?: DisplayPriceFeed;
  /** SSE streams and sockets together; the process's configured stream count. */
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

  stream(request: Request): Response {
    return hintWebResponse(
      request.signal,
      (sink) => this.subscribe(request, sink),
      MARKET_STREAM_HEADERS,
      { highWaterMark: B.queueBytesPerClient, size: (chunk) => chunk?.byteLength ?? 0 },
    );
  }

  /** Whether a socket for these pools and coins fits the shared tables now; it never fills them silently. */
  admits(pools: readonly string[], priceCoins: readonly string[]): boolean {
    const added = pools.filter((pool) => !this.#topics.has(pool)).length;
    return (
      this.#clients.size < this.#maxClients &&
      this.#topics.size + added <= B.maxTopics &&
      (this.#prices?.admits(priceCoins) ?? true)
    );
  }

  subscribe(request: Request, sink?: HintSink, options: MarketSubscribeOptions = {}): HintSubscription {
    const parsed = parseSubscription(request);
    if (!parsed) {
      return publicErrorResponse(
        "invalid_parameter",
        "Invalid subscription to market pools or coin prices.",
        400,
      );
    }
    const { pools, priceCoins, presale } = parsed;
    if (request.signal.aborted)
      return publicErrorResponse(
        "request_cancelled",
        "The request was cancelled.",
        499,
      );
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
    if (!sink) return null;
    const client: Client = {
      pools,
      activity: marketStreamActivity(request) || presale !== null,
      presale,
      sink,
      stop: () => stop(),
    };
    const deadline = options.lifetime === false ? undefined : setTimeout(() => stop(), B.lifetimeMs);
    const stopPrices = this.#prices?.subscribe(priceCoins, (frame) => this.#send(client, event("prices", frame)));
    const stop = () => {
      if (!this.#clients.delete(client)) return;
      clearTimeout(deadline);
      stopPrices?.();
      if (presale) {
        const clients = this.#presales.get(presale);
        clients?.delete(client);
        if (!clients?.size) this.#presales.delete(presale);
      }
      this.#releaseTopics(client);
      sink.close();
      if (!this.#clients.size) this.#disconnect();
    };
    this.#clients.add(client);
    if (presale) {
      const clients = this.#presales.get(presale) ?? new Set<Client>();
      clients.add(client);
      this.#presales.set(presale, clients);
    }
    if (request.headers.has("last-event-id") || new URL(request.url).searchParams.has("cursor")) {
      this.#send(client, event("resync", { reason: "rest-recovery-required" }));
    }
    this.#send(client, event("status", { state: "connecting" }));
    this.#joinTopics(client, options.resume);
    this.#greetHints(client);
    if (!this.#heartbeat) this.#heartbeat = setInterval(() => this.#beat(), B.heartbeatMs);
    if (!this.#socket && !this.#reopen) this.#open();
    else if (this.#ready && added.length) this.#subscribe("subscribe", added);
    return stop;
  }

  #greetHints(client: Client): void {
    if (!client.activity || !this.#hello) return;
    this.#send(client, event("hint", this.#hello));
    if (this.#hintReady) this.#send(client, event("hint", this.#hintPong(client.presale !== null)));
  }

  #joinTopics(client: Client, resume?: ReadonlyMap<string, string>): void {
    for (const pool of client.pools) {
      let topic = this.#topics.get(pool);
      if (!topic) {
        topic = { clients: new Set(), ring: [], ringBytes: 0 };
        this.#topics.set(pool, topic);
      }
      topic.clients.add(client);
      if (!topic.fence) continue;
      const missed = this.#missed(topic, resume?.get(pool));
      if (missed) {
        // The ring holds every frame after the browser's cursor: keep its state, send only what it missed.
        this.#send(client, event("status", { ...topic.fence, cursor: missed.from, resumed: true }));
        for (const frame of missed.frames) this.#send(client, frame.bytes);
      } else this.#send(client, event("status", topic.fence));
      if (topic.stats) this.#send(client, topic.stats.bytes);
    }
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

  #releaseTopics(client: Client): void {
    for (const pool of client.pools) {
      const topic = this.#topics.get(pool);
      if (!topic) continue;
      topic.clients.delete(client);
      if (!topic.clients.size) {
        clearTimeout(topic.deadline);
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
    if (!this.#ready) return;
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
          if (topic && !topic.fence && !topic.deadline)
            topic.deadline = setTimeout(() => this.#stall(pool), 10_000);
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
    } catch {
      this.#end("contract-violation");
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
        if (this.#feedPending) { this.#feedPending = false; return true; }
        if (this.#resumes.length) { this.#resyncPool(this.#resumes.shift()!, "resume-failed"); return true; }
        this.#end("upstream-resync");
        return true;
      case "resync_required":
        // `too_old` answers one resume; the connection stays open.
        if (frame.reason === "too_old" && this.#resumes.length) {
          this.#resyncPool(this.#resumes.shift()!, "too_old");
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
      throw new Error();
    this.#ready = true;
    this.#hello = { type: "hello", provenance: frame.provenance, heartbeat: true, heartbeat_ms: B.heartbeatMs };
    this.#hint(this.#hello);
    this.#reopenAttempt = 0;
    const fenced = [...this.#topics].filter(([, topic]) => topic.resuming && topic.cursor);
    // Resumes go first: the reader answers in order, so an `error` while resumes are pending is a resume's.
    for (const [pool, topic] of fenced) {
      if (!this.#socket) return;
      this.#resume(pool, topic);
    }
    this.#subscribe("subscribe", [...this.#topics].filter(([, topic]) => !topic.resuming || !topic.cursor).map(([pool]) => pool), true);
    this.#ping();
  }

  #pong(socket: RelaySocket, frame: Frame): void {
    if (!this.#ready) throw new Error();
    if (this.#pongDeadline === undefined) return;
    clearTimeout(this.#pongDeadline);
    this.#pongDeadline = undefined;
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
    if (!topic) return;
    const cursor = validateEnvelope(frame, this.#expected);
    if (frame.type === "coin_stats") return this.#stats(topic, frame);
    if (topic.resuming && !this.#endResume(topic, frame, cursor)) return;
    if (topic.cursor && compareEventCursors(cursor, topic.cursor) < 0)
      throw new Error();
    if (frame.type !== "snapshot" && !topic.fence) throw new Error();
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

  #deliver(pool: string, topic: Topic, frame: Frame, cursor: string): void {
    topic.priceMissing = priceMissing(frame) ?? topic.priceMissing;
    topic.cursor = cursor;
    topic.fence = {
      state: "live",
      pool_key: pool,
      checkpoint: frame.checkpoint,
      cursor,
      provenance: frame.provenance,
      ...(topic.priceMissing ? { price_missing: true } : {}),
    };
    if (frame.type === "snapshot") {
      clearTimeout(topic.deadline);
      topic.deadline = undefined;
      topic.ring = [];
      topic.ringBytes = 0;
      topic.floor = cursor;
      if (topic.stats) topic.stats.unsent = false;
      for (const client of topic.clients) {
        this.#send(client, event("status", topic.fence));
        if (topic.stats) this.#send(client, topic.stats.bytes);
      }
    } else {
      const bytes = event("market", stampRelay(withoutLabels(frame), Date.now()), cursor);
      if (bytes.byteLength > B.maxChunkBytes)
        return this.#end("frame-too-large");
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
      topic.deadline = setTimeout(() => this.#resyncPool(pool, "resume-timeout"), 10_000);
    } catch {
      this.#end("upstream-unavailable");
    }
  }


  /** A pool the reader cannot resume ends only its own clients, which reconnect and refetch history. */
  #resyncPool(pool: string, reason: string): void {
    const index = this.#resumes.indexOf(pool);
    if (index >= 0) this.#resumes.splice(index, 1);
    const topic = this.#topics.get(pool);
    if (!topic) return;
    clearTimeout(topic.deadline);
    topic.deadline = undefined;
    const bytes = event("resync", { reason, pool_key: pool });
    for (const client of [...topic.clients]) {
      this.#send(client, bytes);
      client.stop();
    }
  }

  #hint(frame: Frame): void {
    const bytes = event("hint", frame);
    if (bytes.byteLength > ACTIVITY_HINT_STREAM_BUDGET.maxChunkBytes)
      return this.#end("hint-too-large");
    for (const client of this.#clients)
      if (client.activity) this.#send(client, bytes);
  }

  /**
   * A pool the market engine never snapshots (it may not index that coin) fails only its own
   * clients: every other pool on this process keeps streaming.
   */
  #stall(pool: string): void {
    const topic = this.#topics.get(pool);
    if (!topic) return;
    const bytes = event("status", { state: "unavailable", pool_key: pool });
    for (const client of [...topic.clients]) {
      this.#send(client, bytes);
      client.stop();
    }
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
   * The upstream dropped: browsers stay connected and quiet (no heartbeat, so their watchdog
   * runs) while the relay reconnects and resumes every fenced pool from its cursor.
   */
  #lose(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const topic of this.#topics.values()) {
      clearTimeout(topic.deadline);
      topic.deadline = undefined;
      topic.resuming = topic.fence !== undefined;
      topic.resumeChanged = false;
    }
    this.#closeUpstream();
    const delay = Math.min(5_000, 250 * 2 ** this.#reopenAttempt++) * (1 + Math.random() / 2);
    this.#reopen = setTimeout(() => {
      this.#reopen = undefined;
      if (!this.#clients.size) return;
      this.#heartbeat ??= setInterval(() => this.#beat(), B.heartbeatMs);
      this.#open();
    }, delay);
  }

  #disconnect(): void {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#reopen);
    this.#heartbeat = undefined;
    this.#reopen = undefined;
    this.#reopenAttempt = 0;
    for (const topic of this.#topics.values()) clearTimeout(topic.deadline);
    this.#topics.clear();
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
    clearTimeout(this.#pongDeadline);
    this.#pongDeadline = undefined;
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
  }
}
