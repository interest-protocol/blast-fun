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
};
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
export class MarketStreamRelay {
  readonly #connect: () => RelaySocket;
  readonly #expected: ExpectedDeployment;
  readonly #prices?: DisplayPriceFeed;
  readonly #topics = new Map<string, Topic>();
  readonly #presales = new Map<string, Set<Client>>();
  readonly #clients = new Set<Client>();
  #socket: RelaySocket | null = null;
  #ready = false;
  #hello: Frame | null = null;
  #hintReady = false;
  #presaleCheckpoint: number | null = null;
  #feedPending = false;
  #awaitingPong = false;
  #handshake?: ReturnType<typeof setTimeout>;
  #heartbeat?: ReturnType<typeof setInterval>;
  #ending = false;

  constructor(connect: () => RelaySocket, expected: ExpectedDeployment, prices?: DisplayPriceReader) {
    this.#connect = connect;
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

  subscribe(request: Request, sink?: HintSink): HintSubscription {
    let pools: readonly string[];
    let priceCoins: readonly string[];
    let presale: string | null;
    try {
      pools = marketStreamPools(request);
      priceCoins = marketStreamPriceCoins(request);
      presale = marketStreamPresale(request);
    } catch {
      return publicErrorResponse(
        "invalid_parameter",
        "Invalid subscription to market pools or coin prices.",
        400,
      );
    }
    if (request.signal.aborted)
      return publicErrorResponse(
        "request_cancelled",
        "The request was cancelled.",
        499,
      );
    const added = pools.filter((pool) => !this.#topics.has(pool));
    if (
      this.#clients.size >= ACTIVITY_HINT_STREAM_BUDGET.maxClients ||
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
    const deadline = setTimeout(() => stop(), B.lifetimeMs);
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
    this.#joinTopics(client);
    if (client.activity && this.#hello) {
      this.#send(client, event("hint", this.#hello));
      if (this.#hintReady) this.#send(client, event("hint", this.#hintPong(client.presale !== null)));
    }
    if (!this.#heartbeat) this.#heartbeat = setInterval(() => this.#beat(), B.heartbeatMs);
    if (!this.#socket) this.#open();
    else if (this.#ready && added.length) this.#subscribe("subscribe", added);
    return stop;
  }

  #joinTopics(client: Client): void {
    for (const pool of client.pools) {
      let topic = this.#topics.get(pool);
      if (!topic) {
        topic = { clients: new Set() };
        this.#topics.set(pool, topic);
      }
      topic.clients.add(client);
      if (topic.fence) this.#send(client, event("status", topic.fence));
    }
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
    if (this.#awaitingPong) return this.#end("upstream-silent");
    for (const client of this.#clients)
      this.#send(client, HEARTBEAT);
    if (!this.#ready) return;
    try {
      this.#awaitingPong = true;
      this.#socket?.send(JSON.stringify({ op: "ping" }));
    } catch {
      this.#end("upstream-unavailable");
    }
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
        this.#greet(socket, frame);
        return true;
      case "pong":
        this.#pong(socket, frame);
        return true;
      case "resume_complete":
        return true;
      case "error":
        if (this.#feedPending) { this.#feedPending = false; return true; }
        this.#end("upstream-resync");
        return true;
      case "resync_required":
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

  #greet(socket: RelaySocket, frame: Frame): void {
    if (
      this.#ready ||
      frame.protocol !== 1 ||
      deploymentMismatch(parseInfraProvenance(frame.provenance), this.#expected)
    )
      throw new Error();
    this.#ready = true;
    this.#hello = { type: "hello", provenance: frame.provenance, heartbeat: true };
    this.#hint(this.#hello);
    this.#subscribe("subscribe", [...this.#topics.keys()], true);
    this.#awaitingPong = true;
    socket.send(JSON.stringify({ op: "ping" }));
  }

  #pong(socket: RelaySocket, frame: Frame): void {
    this.#awaitingPong = false;
    if (!this.#ready) throw new Error();
    if (this.#hintReady) { this.#feedPending = false; return; }
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
    socket.send(JSON.stringify({ op: "ping" }));
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
      !["snapshot", "trade", "candle_closed", "lifecycle", "opening_round"].includes(
        String(frame.type),
      )
    )
      return;
    const pool = marketPool(frame);
    const topic = this.#topics.get(pool);
    // An unsubscribe can race with already queued, still valid upstream frames.
    if (!topic) return;
    const cursor = validateEnvelope(frame, this.#expected);
    if (topic.cursor && compareEventCursors(cursor, topic.cursor) < 0)
      throw new Error();
    if (frame.type !== "snapshot" && !topic.fence) throw new Error();
    if (frame.type === "trade") validateTrade(frame);
    if (frame.type === "candle_closed") validateCandle(frame);
    if (frame.type === "opening_round")
      parseOpeningRound(frame.opening_round, "opening_round");
    if (
      topic.cursor &&
      frame.type !== "snapshot" &&
      compareEventCursors(cursor, topic.cursor) === 0
    )
      return;
    this.#deliver(pool, topic, frame, cursor);
  }

  #deliver(pool: string, topic: Topic, frame: Frame, cursor: string): void {
    if (frame.type === "snapshot" && Array.isArray(frame.trades)) {
      const latest = frame.trades.map(object).find((trade) => trade.kind !== "opening_round_fill");
      topic.priceMissing = latest !== undefined && latest.price == null;
    } else if (frame.type === "trade") {
      const trade = object(frame.trade);
      topic.priceMissing = trade.price === null;
    }
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
      for (const client of topic.clients)
        this.#send(client, event("status", topic.fence));
    } else {
      const bytes = event("market", withoutLabels(frame), cursor);
      if (bytes.byteLength > B.maxChunkBytes)
        return this.#end("frame-too-large");
      for (const client of topic.clients) this.#send(client, bytes);
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
    this.#ending = true;
    for (const client of [...this.#clients]) {
      this.#send(client, event("resync", { reason }));
      client.stop();
    }
    this.#disconnect();
    this.#ending = false;
  }

  #disconnect(): void {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#handshake);
    this.#heartbeat = undefined;
    this.#handshake = undefined;
    for (const topic of this.#topics.values()) clearTimeout(topic.deadline);
    this.#topics.clear();
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#hello = null;
    this.#hintReady = false;
    this.#presaleCheckpoint = null;
    this.#feedPending = false;
    this.#awaitingPong = false;
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
  }
}
