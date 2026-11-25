import { observeMetric } from "@blast/core/lib/metrics.ts";
import { redisScript, type RedisCommands } from "@blast/core/lib/redis.ts";
import { attestClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { ingressAddress, type IngressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { EVENT_CURSOR } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { verifyLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import {
  MARKET_STREAM_BUDGET,
  MARKET_STREAM_PATH,
  marketStreamPools,
  marketStreamPresale,
  marketStreamPriceCoins,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import type { HintSink, HintSubscription } from "@blast/server/lib/hint-subscription.ts";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
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
  perIp: Object.freeze({ sockets: 8, opensPerMinute: 20, pools: 4, priceCoins: 40 }),
  maxResumes: 2,
  maxClientMessageBytes: 128,
  minPingIntervalMs: 1_000,
  lifetimeMs: Object.freeze({ min: 30 * 60_000, max: 60 * 60_000 }),
  idleTimeoutSeconds: 60,
  maxPayloadBytes: 1_024,
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

/** What the socket needs from the market relay. */
export type LiveRelay = Readonly<{
  admits(pools: readonly string[], priceCoins: readonly string[]): boolean;
  subscribe(
    request: Request,
    sink: HintSink,
    options: Readonly<{ resume?: ReadonlyMap<string, string> }>,
  ): HintSubscription;
}>;

export type LiveSocketOptions = Readonly<{
  /** Hostname the socket is served on, for example `live.blast.fun`. */
  host: string;
  siteOrigin: string;
  gatewaySecret: string;
  namespace: string;
  /** The private-replay Redis: ticket nonces are burned here. */
  redis: RedisCommands;
  ingress: IngressTrust;
  relay: LiveRelay;
  /** Drain closes sockets at random moments within this window. */
  drainMs?: number;
}>;

export type LiveSocketData = {
  ticket: string;
  url: URL;
  rateKey: string;
  /** This socket's member in the shared per-IP set, once Redis admitted it. */
  id: string;
  admitted: boolean;
  closing: boolean;
  slow: boolean;
  lastPing: number;
  pools: readonly string[];
  priceCoins: readonly string[];
  stop?: () => void;
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
  resume: ReadonlyMap<string, string>;
}>;

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
  marketStreamPresale(request);
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
  return { request, pools, priceCoins, resume };
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

  const ipKey = (rateKey: string, kind: "sockets" | "opens") =>
    `${options.namespace}:live-ip:${kind}:${rateKey}`;
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
    forget(ipKey(data.rateKey, "sockets"), data.id);
    void flush();
  };

  const release = (ws: Socket) => {
    const data = ws.data;
    if (!sockets.delete(ws)) {
      return;
    }
    clearTimeout(data.lifetime);
    const stop = data.stop;
    data.stop = undefined;
    stop?.();
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
      ws.data.stop = undefined;
      shut(ws, ws.data.slow ? LIVE_CLOSE.slow : LIVE_CLOSE.done);
    },
  });

  /** This instance's tables: distinct pools and coins for one address. */
  const crowded = (rateKey: string, query: Query) => {
    const entry = addresses.get(rateKey);
    return (
      !!entry &&
      (distinct(entry.pools, query.pools) > LIVE_SOCKET.perIp.pools ||
        distinct(entry.priceCoins, query.priceCoins) > LIVE_SOCKET.perIp.priceCoins)
    );
  };
  const hold = (data: LiveSocketData, query: Query) => {
    const entry = address(data.rateKey);
    data.admitted = true;
    data.pools = query.pools;
    data.priceCoins = query.priceCoins;
    entry.sockets++;
    count(entry.pools, query.pools, 1);
    count(entry.priceCoins, query.priceCoins, 1);
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
          `${options.namespace}:live-ticket:${ticket.nonce}`,
          ipKey(data.rateKey, "sockets"),
          ipKey(data.rateKey, "opens"),
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
    const ticket = verifyLiveTicket(options.gatewaySecret, data.ticket, options.siteOrigin);
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
    if (crowded(data.rateKey, query)) {
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
    const result = options.relay.subscribe(query.request, sink(ws), { resume: query.resume });
    if (typeof result !== "function") {
      if (!data.closing) {
        shut(ws, result.status === 400 ? LIVE_CLOSE.query : LIVE_CLOSE.busy);
      }
      return;
    }
    if (data.closing) {
      return result();
    }
    data.stop = result;
    const { min, max } = LIVE_SOCKET.lifetimeMs;
    data.lifetime = setTimeout(
      () => shut(ws, LIVE_CLOSE.done),
      min + Math.floor(Math.random() * (max - min)),
    );
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
      if (
        typeof message !== "string" ||
        message.length > LIVE_SOCKET.maxClientMessageBytes ||
        now - ws.data.lastPing < LIVE_SOCKET.minPingIntervalMs
      ) {
        return shut(ws, LIVE_CLOSE.message);
      }
      let ping: unknown;
      try {
        ping = JSON.parse(message);
      } catch {
        return shut(ws, LIVE_CLOSE.message);
      }
      const { op, t, ...rest } = (ping && typeof ping === "object" ? ping : {}) as Record<
        string,
        unknown
      >;
      if (op !== "ping" || !Number.isSafeInteger(t) || Object.keys(rest).length) {
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
      if (host !== options.host || request.headers.get("origin") !== options.siteOrigin) {
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
        url: new URL(request.url),
        rateKey: client.rateKey,
        id: "",
        admitted: false,
        closing: false,
        slow: false,
        lastPing: 0,
        pools: [],
        priceCoins: [],
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
