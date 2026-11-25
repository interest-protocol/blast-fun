import { observeMetric } from "@blast/core/lib/metrics.ts";
import type { RedisCommands } from "@blast/core/lib/redis.ts";
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

/** What the socket needs from the market relay. */
export type LiveRelay = Readonly<{
  admits(pools: readonly string[], priceCoins: readonly string[]): boolean;
  subscribe(
    request: Request,
    sink: HintSink,
    options: Readonly<{ resume?: ReadonlyMap<string, string>; lifetime?: boolean }>,
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
type Address = {
  sockets: number;
  opens: number[];
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

/** The socket query is the SSE query plus `resume=<pool>~<cursor>`; `cursor` stays SSE-only. */
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

  const address = (key: string) => {
    let entry = addresses.get(key);
    if (!entry) {
      addresses.set(
        key,
        (entry = { sockets: 0, opens: [], pools: new Map(), priceCoins: new Map() }),
      );
    }
    return entry;
  };
  const prune = (entry: Address, now: number) => {
    while (entry.opens.length && entry.opens[0]! <= now - 60_000) {
      entry.opens.shift();
    }
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of addresses) {
      prune(entry, now);
      if (!entry.sockets && !entry.opens.length) {
        addresses.delete(key);
      }
    }
  }, 60_000);
  sweep.unref?.();

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
      entry.sockets--;
      count(entry.pools, data.pools, -1);
      count(entry.priceCoins, data.priceCoins, -1);
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
    const now = Date.now();
    const entry = address(data.rateKey);
    prune(entry, now);
    if (
      entry.sockets >= LIVE_SOCKET.perIp.sockets ||
      entry.opens.length >= LIVE_SOCKET.perIp.opensPerMinute ||
      distinct(entry.pools, query.pools) > LIVE_SOCKET.perIp.pools ||
      distinct(entry.priceCoins, query.priceCoins) > LIVE_SOCKET.perIp.priceCoins
    ) {
      return shut(ws, LIVE_CLOSE.perIp);
    }
    entry.opens.push(now);
    if (draining || !options.relay.admits(query.pools, query.priceCoins)) {
      return shut(ws, LIVE_CLOSE.busy);
    }
    // Hold this address's slot while Redis answers, so parallel opens cannot overrun it.
    data.admitted = true;
    data.pools = query.pools;
    data.priceCoins = query.priceCoins;
    entry.sockets++;
    count(entry.pools, query.pools, 1);
    count(entry.priceCoins, query.priceCoins, 1);
    let burned: unknown;
    try {
      burned = await options.redis.execute([
        "SET",
        `${options.namespace}:live-ticket:${ticket.nonce}`,
        "1",
        "NX",
        "PX",
        String(Math.max(1, ticket.expiresAtMs - Date.now())),
      ]);
    } catch {
      return shut(ws, LIVE_CLOSE.busy);
    }
    if (data.closing) {
      return;
    }
    if (burned !== "OK") {
      return shut(ws, LIVE_CLOSE.ticket);
    }
    const result = options.relay.subscribe(query.request, sink(ws), {
      resume: query.resume,
      lifetime: false,
    });
    if (typeof result !== "function") {
      if (!data.closing) {
        shut(ws, result?.status === 400 ? LIVE_CLOSE.query : LIVE_CLOSE.busy);
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
        // Shows which proxy peers (their /24 or /64, the narrowest trusted range) and header shapes arrive, never a client address.
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
      clearInterval(sweep);
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
      ).then(() => {});
    },
  };
}

export type LiveSocket = ReturnType<typeof createLiveSocket>;
