import { observeMetric } from "@blast/core/lib/metrics.ts";
import { redisScript, type RedisCommands } from "@blast/core/lib/redis.ts";
import { attestClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { ingressAddress, type IngressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { EVENT_CURSOR } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { verifyLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import {
  MARKET_STREAM_BUDGET,
  MARKET_STREAM_PATH,
  marketStreamDiscovery,
  marketStreamPools,
  marketStreamPresale,
  marketStreamPriceCoins,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import type { HintSink } from "@blast/server/lib/hint-subscription.ts";
import { limitedPriceCoins } from "@blast/server/modules/launchpad-market/display-price-feed.ts";
import {
  trackedCuePools,
  type MarketSet,
  type MarketSubscription,
} from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { TrustedSite } from "./contracts.ts";
import { randomUUID } from "node:crypto";

/**
 * The direct browser socket: `wss://<live host>/v1/socket`. Each message is one
 * SSE event block from the market relay. Admission and limits follow
 * docs/architecture/live-data-delivery.md ("Direct browser socket: security review").
 */
export const LIVE_SOCKET = Object.freeze({
  path: "/v1/socket",
  protocol: "blast-live.v1",
  ticketPrefix: "blast-ticket.",
  perIp: Object.freeze({
    sockets: 8,
    opensPerMinute: 20,
    pools: 4,
    /** Distinct price coins; Create's quote coins (`CREATE_QUOTE_TYPES`) do not count. */
    priceCoins: 40,
    /** Pools added by `set` on this instance; each can cost an upstream snapshot. */
    addedPoolsPerMinute: 40,
  }),
  maxResumes: 2,
  /** Longest client frame per op, in characters. */
  maxClientMessage: Object.freeze({ ping: 128, set: 8_192 }),
  minPingIntervalMs: 1_000,
  setsPerMinute: 10,
  lifetimeMs: Object.freeze({ min: 30 * 60_000, max: 60 * 60_000 }),
  idleTimeoutSeconds: 60,
  maxPayloadBytes: 8_192,
  backpressureBytes: 256 * 1_024,
});

export const LIVE_CLOSE = Object.freeze({
  done: 1000,
  message: 1008,
  drain: 1012,
  query: 4400,
  ticket: 4401,
  slow: 4408,
  perIp: 4429,
  busy: 4503,
});

/**
 * One atomic step on the private-replay Redis: per-IP socket and open counts
 * across every instance, then the single-use ticket burn. Checks come before
 * any write; Redis owns the clock. A socket's entry expires after the longest
 * socket life, so a crashed instance leaks a slot for at most that long.
 * KEYS: ticket, IP sockets, IP opens. ARGV: ticket ms, socket id, socket cap,
 * opens cap, socket entry ms. Returns 1 admitted, 0 ticket reused, 2 per IP.
 */
const admitScript = redisScript(`
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local life = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - 60000)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) or redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[4]) then return 2 end
if not redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[2], now + life, ARGV[2])
redis.call('PEXPIRE', KEYS[2], life)
redis.call('ZADD', KEYS[3], now, ARGV[2])
redis.call('PEXPIRE', KEYS[3], 60000)
return 1
`);
/** Removal retry pace and bounds: at most 8 entries can exist per address. */
const REMOVAL = { retryMs: 2_000, idsPerKey: 32, keys: 4_096, batchKeys: 64 } as const;
/** Room past the longest socket life before a leaked slot frees itself. */
const SOCKET_ENTRY_MS = LIVE_SOCKET.lifetimeMs.max + 5 * 60_000;
const MINUTE_MS = 60_000;
/** How long a refused `set` asks the browser to wait, by reason; `rate` and `churn` wait for their window. */
const SET_RETRY_MS = { per_ip: 60_000, busy: 5_000 } as const;

/** What the socket needs from the market relay. */
export type LiveRelay = Readonly<{
  /** A new socket fits the relay's tables. */
  admits(pools: readonly string[], priceCoins: readonly string[]): boolean;
  /** An open socket may add these pools and coins. */
  fits(pools: readonly string[], priceCoins: readonly string[], tradeCues?: boolean): boolean;
  subscribe(
    request: Request,
    sink: HintSink,
    options: Readonly<{ resume?: ReadonlyMap<string, string> }>,
  ): Response | MarketSubscription;
}>;

export type LiveSocketOptions = Readonly<{
  /** Hostname the socket is served on, for example `live.blast.fun`. */
  host: string;
  siteOrigin: string;
  gatewaySecret: string;
  namespace: string;
  /** Other trusted sites: a socket's Origin picks its site, its ticket origin and its namespace. */
  extraSites?: readonly TrustedSite[];
  /** The private-replay Redis: ticket nonces are burned here. */
  redis: RedisCommands;
  ingress: IngressTrust;
  relay: LiveRelay;
  /** Drain closes sockets at random moments within this window. */
  drainMs?: number;
}>;

export type LiveSocketData = {
  ticket: string;
  /** The trusted site this socket's Origin matched. */
  site: TrustedSite;
  url: URL;
  rateKey: string;
  /** This socket's member in the shared per-IP set, once Redis admitted it. */
  id: string;
  admitted: boolean;
  closing: boolean;
  slow: boolean;
  lastPing: number;
  /** When this socket's recent `set`s arrived, oldest first. */
  sets: number[];
  /** This socket was refused `rate` in the current window; one more over-rate `set` closes it. */
  rateRefused: boolean;
  /** What the socket holds now; always matches the address tables. */
  pools: readonly string[];
  priceCoins: readonly string[];
  presale: string | null;
  discovery?: boolean;
  tradeCues?: boolean;
  /** The relay handle, once admitted: a `set` before it closes the socket. */
  relay?: MarketSubscription;
  lifetime?: ReturnType<typeof setTimeout>;
};

type Socket = ServerWebSocket<LiveSocketData>;
/** Distinct pools and coins per IP guard this process's own tables, so they stay per instance. */
type Address = {
  sockets: number;
  pools: Map<string, number>;
  priceCoins: Map<string, number>;
};
type Query = Readonly<{
  request: Request;
  pools: readonly string[];
  priceCoins: readonly string[];
  presale: string | null;
  discovery?: boolean;
  resume: ReadonlyMap<string, string>;
}>;
type SetRefusal = "rate" | "per_ip" | "churn" | "busy";

const NO_STORE = { "Cache-Control": "private, no-store" };
const decoder = new TextDecoder();
/** One frame's bytes are shared by every subscriber; decode them once. */
const texts = new WeakMap<Uint8Array, string>();
const text = (chunk: Uint8Array) => {
  let value = texts.get(chunk);
  if (value === undefined) {
    texts.set(chunk, (value = decoder.decode(chunk)));
  }
  return value;
};

/** The market stream query plus `resume=<pool>~<cursor>`; `cursor` is refused. */
export function liveSocketQuery(url: URL): Query {
  const params = new URLSearchParams(url.search);
  const resumes = params.getAll("resume");
  params.delete("resume");
  if (params.has("cursor") || resumes.length > LIVE_SOCKET.maxResumes) {
    throw new Error("Invalid live query.");
  }
  const request = new Request(`https://live.internal${MARKET_STREAM_PATH}?${params}`);
  const pools = marketStreamPools(request);
  const priceCoins = marketStreamPriceCoins(request);
  const presale = marketStreamPresale(request);
  const resume = new Map<string, string>();
  for (const value of resumes) {
    const [pool = "", cursor = "", ...rest] = value.split("~");
    if (
      rest.length ||
      !POOL_KEY.test(pool) ||
      !EVENT_CURSOR.test(cursor) ||
      resume.has(pool) ||
      !pools.includes(pool)
    ) {
      throw new Error("Invalid live resume.");
    }
    resume.set(pool, cursor);
  }
  return {
    request,
    pools,
    priceCoins,
    presale,
    resume,
    ...(marketStreamDiscovery(request) ? { discovery: true } : {}),
  };
}

const SET_KEYS = ["op", "seq", "pools", "price_coins", "presale"].sort().join();
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * A client `set`: the whole wanted set, checked by the same parsers as the URL so the rules
 * cannot drift. `activity` stays as the socket opened. Throws on anything else.
 */
export function liveSetMessage(frame: Record<string, unknown>): { seq: number } & MarketSet {
  const { discovery, trade_cues: tradeCues, ...required } = frame;
  const { seq, pools, price_coins: coins, presale } = required;
  const keys = Object.keys(required).sort().join();
  if (
    keys !== SET_KEYS ||
    ("discovery" in frame && typeof discovery !== "boolean") ||
    ("trade_cues" in frame && typeof tradeCues !== "boolean") ||
    !Number.isSafeInteger(seq) ||
    !strings(pools) ||
    !strings(coins) ||
    (presale !== null && typeof presale !== "string")
  ) {
    throw new Error("Invalid live set.");
  }
  const params = new URLSearchParams({ activity: "true" });
  for (const pool of pools) {
    params.append("pool", pool);
  }
  for (const coin of coins) {
    params.append("price_coin", coin);
  }
  if (presale !== null) {
    params.set("presale", presale);
  }
  const request = new Request(`https://live.internal${MARKET_STREAM_PATH}?${params}`);
  return {
    seq: seq as number,
    pools: marketStreamPools(request),
    priceCoins: marketStreamPriceCoins(request),
    presale: marketStreamPresale(request),
    ...(discovery === true ? { discovery: true } : {}),
    ...(tradeCues === true ? { tradeCues: true } : {}),
  };
}

export function createLiveSocket(options: LiveSocketOptions) {
  const sockets = new Set<Socket>();
  const addresses = new Map<string, Address>();
  let draining = false;
  // Socket ids to remove from the shared per-IP sets, by key. A failed removal is
  // retried, so a Redis stall or a burst of closes never leaves a phantom slot.
  const removals = new Map<string, Set<string>>();
  let flushing: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const sites: readonly TrustedSite[] = [
    { siteOrigin: options.siteOrigin, namespace: options.namespace },
    ...(options.extraSites ?? []),
  ];
  // Pools each address added by `set` in the last minute, oldest first. Kept apart from
  // `addresses` so closing every socket and reopening does not reset the window.
  const churn = new Map<string, number[]>();
  let churnSweptAt = 0;
  const recent = (times: number[], now: number) => {
    while (times.length && times[0]! <= now - MINUTE_MS) {
      times.shift();
    }
    return times;
  };
  const addedPools = (rateKey: string, now: number) => {
    if (now - churnSweptAt >= MINUTE_MS) {
      churnSweptAt = now;
      for (const [key, times] of churn) {
        if (!recent(times, now).length) {
          churn.delete(key);
        }
      }
    }
    let times = churn.get(rateKey);
    if (!times) {
      churn.set(rateKey, (times = []));
    }
    return recent(times, now);
  };

  const ipKey = (data: LiveSocketData, kind: "sockets" | "opens") =>
    `${data.site.namespace}:live-ip:${kind}:${data.rateKey}`;
  const address = (key: string) => {
    let entry = addresses.get(key);
    if (!entry) {
      addresses.set(key, (entry = { sockets: 0, pools: new Map(), priceCoins: new Map() }));
    }
    return entry;
  };

  const count = (table: Map<string, number>, keys: readonly string[], step: 1 | -1) => {
    for (const key of keys) {
      const next = (table.get(key) ?? 0) + step;
      if (next > 0) {
        table.set(key, next);
      } else {
        table.delete(key);
      }
    }
  };
  const distinct = (table: Map<string, number>, keys: readonly string[]) =>
    new Set([...table.keys(), ...keys]).size;

  /** Send queued removals in batches; a failed batch waits for the retry timer. */
  async function sendRemovals() {
    while (removals.size) {
      const batch = [...removals].slice(0, REMOVAL.batchKeys);
      for (const [key] of batch) {
        removals.delete(key);
      }
      const results = await Promise.allSettled(
        batch.map(async ([key, ids]) => options.redis.execute(["ZREM", key, ...ids])),
      );
      const failed = batch.filter((_, index) => results[index]!.status === "rejected");
      for (const [key, ids] of failed) {
        forget(key, ...ids);
      }
      if (failed.length) {
        if (!retry && !stopped) {
          retry = setTimeout(() => {
            retry = undefined;
            void flush();
          }, REMOVAL.retryMs);
          retry.unref();
        }
        return;
      }
    }
  }

  const flush = (): Promise<void> =>
    (flushing ??= sendRemovals().finally(() => {
      flushing = undefined;
    }));

  // Bounded while Redis is down: anything dropped frees itself when its entry expires.
  function forget(key: string, ...ids: readonly string[]) {
    let set = removals.get(key);
    if (!set) {
      if (removals.size >= REMOVAL.keys) {
        return;
      }
      removals.set(key, (set = new Set()));
    }
    for (const id of ids) {
      set.add(id);
      if (set.size > REMOVAL.idsPerKey) {
        set.delete(set.values().next().value!);
      }
    }
  }

  const unclaim = (data: LiveSocketData) => {
    forget(ipKey(data, "sockets"), data.id);
    void flush();
  };

  const release = (ws: Socket) => {
    const data = ws.data;
    if (!sockets.delete(ws)) {
      return;
    }
    clearTimeout(data.lifetime);
    const relay = data.relay;
    data.relay = undefined;
    relay?.stop();
    if (data.admitted) {
      const entry = address(data.rateKey);
      count(entry.pools, data.pools, -1);
      count(entry.priceCoins, data.priceCoins, -1);
      if (--entry.sockets === 0) {
        addresses.delete(data.rateKey);
      }
    }
    if (data.id) {
      unclaim(data);
    }
  };
  const shut = (ws: Socket, code: number) => {
    if (ws.data.closing) {
      return;
    }
    ws.data.closing = true;
    release(ws);
    observeMetric("live.socket.close", { code });
    // Render's edge delivers custom close codes as 1005: the last frame names the code for the browser.
    ws.send(`event: close\ndata: {"code":${code}}\n\n`);
    ws.close(code);
  };

  const sink = (ws: Socket): HintSink => ({
    send(chunk) {
      if (ws.data.closing) {
        return false;
      }
      if (ws.send(text(chunk)) === 0) {
        return false;
      }
      if (ws.getBufferedAmount() > MARKET_STREAM_BUDGET.queueBytesPerClient) {
        ws.data.slow = true;
        return false;
      }
      return true;
    },
    close() {
      ws.data.relay = undefined;
      shut(ws, ws.data.slow ? LIVE_CLOSE.slow : LIVE_CLOSE.done);
    },
  });

  /** This instance's tables: distinct pools and coins for one address. */
  const crowded = (rateKey: string, pools: readonly string[], priceCoins: readonly string[]) => {
    const entry = addresses.get(rateKey);
    return (
      !!entry &&
      (distinct(entry.pools, pools) > LIVE_SOCKET.perIp.pools ||
        new Set(limitedPriceCoins([...entry.priceCoins.keys(), ...priceCoins])).size > LIVE_SOCKET.perIp.priceCoins)
    );
  };
  /** Moves this socket's share of the address tables from what it holds to `next`. */
  const take = (data: LiveSocketData, next: MarketSet) => {
    const entry = address(data.rateKey);
    count(entry.pools, data.pools, -1);
    count(entry.priceCoins, data.priceCoins, -1);
    count(entry.pools, next.pools, 1);
    count(entry.priceCoins, next.priceCoins, 1);
    data.pools = next.pools;
    data.priceCoins = next.priceCoins;
    data.presale = next.presale;
    data.discovery = next.discovery;
    data.tradeCues = next.tradeCues;
  };

  /** Removes stale topics first so refused additions cannot leave the old page subscribed. */
  function dropUnwanted(
    data: LiveSocketData,
    relay: MarketSubscription,
    next: MarketSet,
  ): MarketSet {
    const kept: MarketSet = {
      pools: data.pools.filter((pool) => next.pools.includes(pool)),
      priceCoins: data.priceCoins.filter((coin) => next.priceCoins.includes(coin)),
      presale: next.presale === data.presale ? data.presale : null,
      ...(next.discovery && data.discovery ? { discovery: true } : {}),
      ...(next.tradeCues && data.tradeCues ? { tradeCues: true } : {}),
    };
    if (
      kept.pools.length !== data.pools.length ||
      kept.priceCoins.length !== data.priceCoins.length ||
      kept.presale !== data.presale ||
      kept.discovery !== data.discovery ||
      kept.tradeCues !== data.tradeCues
    ) {
      take(data, kept);
      relay.set(kept);
    }
    return kept;
  }

  const hold = (data: LiveSocketData, query: Query) => {
    data.admitted = true;
    address(data.rateKey).sockets++;
    take(data, query);
  };
  /** The fleet-wide part, in one Redis step: null admits, otherwise the close code. */
  const claim = async (data: LiveSocketData, ticket: { nonce: string; expiresAtMs: number }) => {
    // Set before the call: a close while Redis answers still removes the entry.
    data.id = randomUUID();
    let result: unknown;
    try {
      result = await admitScript(
        options.redis,
        [
          `${data.site.namespace}:live-ticket:${ticket.nonce}`,
          ipKey(data, "sockets"),
          ipKey(data, "opens"),
        ],
        [
          String(Math.max(1, ticket.expiresAtMs - Date.now())),
          data.id,
          String(LIVE_SOCKET.perIp.sockets),
          String(LIVE_SOCKET.perIp.opensPerMinute),
          String(SOCKET_ENTRY_MS),
        ],
      );
    } catch {
      // A deadline can fire after the script ran: remove the entry it may have added.
      unclaim(data);
      data.id = "";
      return LIVE_CLOSE.busy;
    }
    if (result === 1) {
      return null;
    }
    // Both refusals happen before the add: nothing to remove.
    data.id = "";
    return result === 2 ? LIVE_CLOSE.perIp : LIVE_CLOSE.ticket;
  };

  async function admit(ws: Socket) {
    const data = ws.data;
    const ticket = verifyLiveTicket(options.gatewaySecret, data.ticket, data.site.siteOrigin);
    data.ticket = "";
    if (!ticket) {
      return shut(ws, LIVE_CLOSE.ticket);
    }
    let query: Query;
    try {
      query = liveSocketQuery(data.url);
    } catch {
      return shut(ws, LIVE_CLOSE.query);
    }
    if (crowded(data.rateKey, query.pools, query.priceCoins)) {
      return shut(ws, LIVE_CLOSE.perIp);
    }
    if (draining || !options.relay.admits(query.pools, query.priceCoins)) {
      return shut(ws, LIVE_CLOSE.busy);
    }
    // Hold this address's pools and coins while Redis answers, so parallel opens cannot overrun them.
    hold(data, query);
    const refused = await claim(data, ticket);
    if (refused) {
      return shut(ws, refused);
    }
    if (data.closing) {
      // The removal sent at close can reach Redis before the add (NOSCRIPT falls back to EVAL).
      return unclaim(data);
    }
    // Another open may have filled the shared tables while Redis answered; nothing awaits from here.
    if (!options.relay.fits(query.pools, query.priceCoins)) {
      return shut(ws, LIVE_CLOSE.busy);
    }
    const result = options.relay.subscribe(query.request, sink(ws), { resume: query.resume });
    if (result instanceof Response) {
      if (!data.closing) {
        shut(ws, result.status === 400 ? LIVE_CLOSE.query : LIVE_CLOSE.busy);
      }
      return;
    }
    if (data.closing) {
      return result.stop();
    }
    data.relay = result;
    const { min, max } = LIVE_SOCKET.lifetimeMs;
    data.lifetime = setTimeout(
      () => shut(ws, LIVE_CLOSE.done),
      min + Math.floor(Math.random() * (max - min)),
    );
  }

  /**
   * A `set`: the whole wanted set on an open socket. Removals always apply; additions are all or
   * nothing. Checks, in order: frame, state, per-socket rate, removals, per-IP pools and coins,
   * per-IP added-pool churn, then the relay's shared tables. The answer goes out before the relay
   * joins added pools, so it precedes their catch-up. No Redis: a `set` opens nothing.
   */
  function changeSet(ws: Socket, frame: Record<string, unknown>, now: number) {
    const data = ws.data;
    let seq: number;
    let next: MarketSet;
    try {
      ({ seq, ...next } = liveSetMessage(frame));
    } catch {
      return shut(ws, LIVE_CLOSE.message);
    }
    const relay = data.relay;
    if (!relay || data.closing) {
      return shut(ws, LIVE_CLOSE.message);
    }
    const answer = (refusal?: SetRefusal, retryMs?: number) => {
      ws.send(
        `event: set\ndata: ${JSON.stringify({
          seq,
          ok: !refusal,
          ...(refusal ? { reason: refusal, retry_ms: retryMs } : {}),
          held: {
            pools: data.pools,
            price_coins: data.priceCoins,
            presale: data.presale,
            ...(data.discovery ? { discovery: true } : {}),
            ...(data.tradeCues ? { trade_cues: true } : {}),
          },
        })}\n\n`,
      );
    };
    if (draining) {
      return answer("busy", SET_RETRY_MS.busy);
    }
    const sets = recent(data.sets, now);
    if (sets.length >= LIVE_SOCKET.setsPerMinute) {
      if (data.rateRefused) {
        return shut(ws, LIVE_CLOSE.message);
      }
      data.rateRefused = true;
      return answer("rate", sets[0]! + MINUTE_MS - now);
    }
    data.rateRefused = false;
    sets.push(now);

    const kept = dropUnwanted(data, relay, next);
    if (data.closing) {
      return;
    }
    const pools = next.pools.filter((pool) => !kept.pools.includes(pool));
    const coins = next.priceCoins.filter((coin) => !kept.priceCoins.includes(coin));
    if (crowded(data.rateKey, pools, coins)) {
      return answer("per_ip", SET_RETRY_MS.per_ip);
    }
    const keptPoolTopics = new Set([
      ...kept.pools,
      ...trackedCuePools(kept.priceCoins, kept.tradeCues),
    ]);
    const nextPoolTopics = new Set([
      ...next.pools,
      ...trackedCuePools(next.priceCoins, next.tradeCues),
    ]);
    const poolJoins = [...nextPoolTopics].filter((pool) => !keptPoolTopics.has(pool));
    const added = addedPools(data.rateKey, now);
    const over = added.length + poolJoins.length - LIVE_SOCKET.perIp.addedPoolsPerMinute;
    if (over > 0) {
      return answer("churn", added[over - 1]! + MINUTE_MS - now);
    }
    if (!options.relay.fits(pools, next.tradeCues ? next.priceCoins : coins, next.tradeCues)) {
      return answer("busy", SET_RETRY_MS.busy);
    }
    take(data, next);
    added.push(...poolJoins.map(() => now));
    answer();
    relay.set(next);
  }

  const websocket: WebSocketHandler<LiveSocketData> = {
    idleTimeout: LIVE_SOCKET.idleTimeoutSeconds,
    sendPings: true,
    maxPayloadLength: LIVE_SOCKET.maxPayloadBytes,
    backpressureLimit: LIVE_SOCKET.backpressureBytes,
    closeOnBackpressureLimit: true,
    perMessageDeflate: false,
    open(ws) {
      sockets.add(ws);
      void admit(ws).catch(() => shut(ws, LIVE_CLOSE.busy));
    },
    message(ws, message) {
      const now = Date.now();
      if (typeof message !== "string" || message.length > LIVE_SOCKET.maxClientMessage.set) {
        return shut(ws, LIVE_CLOSE.message);
      }
      let frame: unknown;
      try {
        frame = JSON.parse(message);
      } catch {
        return shut(ws, LIVE_CLOSE.message);
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        return shut(ws, LIVE_CLOSE.message);
      }
      const fields = frame as Record<string, unknown>;
      if (fields.op === "set") {
        return changeSet(ws, fields, now);
      }
      const { op, t, ...rest } = fields;
      if (
        op !== "ping" ||
        message.length > LIVE_SOCKET.maxClientMessage.ping ||
        now - ws.data.lastPing < LIVE_SOCKET.minPingIntervalMs ||
        !Number.isSafeInteger(t) ||
        Object.keys(rest).length
      ) {
        return shut(ws, LIVE_CLOSE.message);
      }
      ws.data.lastPing = now;
      ws.send(`event: pong\ndata: ${JSON.stringify({ t, server_ms: Date.now() })}\n\n`);
    },
    close(ws) {
      ws.data.closing = true;
      release(ws);
    },
  };

  return {
    websocket,
    /** A Response refuses before upgrade; undefined means Bun owns the socket now. */
    upgrade(
      request: Request,
      server: Server<LiveSocketData>,
      peer: string | null,
    ): Response | undefined {
      const forbidden = () => new Response(null, { status: 403, headers: NO_STORE });
      let host: string;
      try {
        host = new URL(`http://${request.headers.get("host") ?? ""}`).hostname;
      } catch {
        return forbidden();
      }
      const site = sites.find(({ siteOrigin }) => siteOrigin === request.headers.get("origin"));
      if (host !== options.host || !site) {
        return forbidden();
      }
      const offered = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((value) => value.trim());
      if (!offered.includes(LIVE_SOCKET.protocol)) {
        return forbidden();
      }
      const client = attestClientAddress(ingressAddress(request, peer, options.ingress));
      if (!client) {
        // Shows which proxy peers (their /24 or /64) and header shapes arrive, never a client address.
        observeMetric("live.socket.refused", {
          cause: "client-address",
          ingress: options.ingress.mode,
          peer_prefix: peer?.includes(".")
            ? peer.split(".").slice(0, 3).join(".")
            : (peer?.split(":").slice(0, 4).join(":") ?? null),
          forwarded_entries: request.headers.get("x-forwarded-for")?.split(",").length ?? 0,
        });
        return forbidden();
      }
      if (draining) {
        return new Response(null, { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } });
      }
      const tickets = offered.filter((value) => value.startsWith(LIVE_SOCKET.ticketPrefix));
      const data: LiveSocketData = {
        ticket: tickets.length === 1 ? tickets[0]!.slice(LIVE_SOCKET.ticketPrefix.length) : "",
        site,
        url: new URL(request.url),
        rateKey: client.rateKey,
        id: "",
        admitted: false,
        closing: false,
        slow: false,
        lastPing: 0,
        sets: [],
        rateRefused: false,
        pools: [],
        priceCoins: [],
        presale: null,
      };
      // Echo only the protocol name, never the ticket entry.
      return server.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": LIVE_SOCKET.protocol },
        data,
      })
        ? undefined
        : new Response(null, { status: 426, headers: NO_STORE });
    },
    stats: () => ({ sockets: sockets.size, addresses: addresses.size }),
    /** Close every socket with 1012 at a random moment within the drain window. */
    drain(): Promise<void> {
      draining = true;
      const window = options.drainMs ?? 0;
      return Promise.all(
        [...sockets].map(
          (ws) =>
            new Promise<void>((resolve) =>
              setTimeout(
                () => {
                  shut(ws, LIVE_CLOSE.drain);
                  resolve();
                },
                Math.floor(Math.random() * window),
              ),
            ),
        ),
      )
        .then(() => {
          clearTimeout(retry);
          retry = undefined;
          return flush();
        })
        .then(() => (removals.size ? flush() : undefined))
        .finally(() => {
          stopped = true;
          clearTimeout(retry);
        });
    },
  };
}

export type LiveSocket = ReturnType<typeof createLiveSocket>;
