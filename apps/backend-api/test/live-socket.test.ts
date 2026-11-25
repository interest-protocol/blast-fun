import assert from "node:assert/strict";
import test from "node:test";
import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import type { HintSink } from "@blast/server/lib/hint-subscription.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { RelaySocket } from "@blast/server/modules/social/activity/hint-relay.ts";
import { createLiveSocket, LIVE_CLOSE, type LiveRelay, type LiveSocketData } from "../src/transport/live-socket.ts";

const SECRET = "s".repeat(48);
const ORIGIN = "https://blast.fun";
const pool = (index: number) => `blast_curve:0x${index.toString(16).padStart(64, "0")}`;
const coin = (index: number) => `0x${index.toString(16).padStart(64, "0")}::coin::COIN`;

type Sub = { url: string; sink: HintSink; resume?: ReadonlyMap<string, string>; lifetime?: boolean; stopped: boolean };

function harness(relay?: LiveRelay, redisDown = false) {
  const burned = new Set<string>();
  const subs: Sub[] = [];
  const fake: LiveRelay = relay ?? {
    admits: () => true,
    subscribe(request, sink, options) {
      const sub: Sub = { url: request.url, sink, ...options, stopped: false };
      subs.push(sub);
      sink.send(new TextEncoder().encode('event: status\ndata: {"state":"connecting"}\n\n'));
      return () => { sub.stopped = true; };
    },
  };
  const live = createLiveSocket({
    host: "127.0.0.1",
    siteOrigin: ORIGIN,
    gatewaySecret: SECRET,
    namespace: "test",
    ingress: { mode: "direct" },
    relay: fake,
    redis: {
      async execute(args: string[]) {
        if (redisDown) throw new Error("down");
        assert.equal(args[0], "SET");
        assert.match(args[1]!, /^test:live-ticket:/);
        if (burned.has(args[1]!)) return null;
        burned.add(args[1]!);
        return "OK";
      },
    },
  });
  const server = Bun.serve<LiveSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    websocket: live.websocket,
    fetch(request, native) {
      return live.upgrade(request, native, native.requestIP(request)?.address ?? null) ?? new Response(null);
    },
  });
  const url = (query: string) => `ws://127.0.0.1:${server.port}/v1/socket?${query}`;
  const open = (query: string, ticket = mintLiveTicket(SECRET, ORIGIN).ticket, origin = ORIGIN) => {
    const ws = new WebSocket(url(query), {
      headers: { Origin: origin },
      protocols: ["blast-live.v1", `blast-ticket.${ticket}`],
    } as unknown as string[]);
    const messages: string[] = [];
    ws.onmessage = (message) => messages.push(String(message.data));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    const opened = new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    return { ws, messages, closed, opened };
  };
  return { live, server, subs, open, url };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  assert.ok(check());
};

test("a ticketed socket gets SSE blocks, answers pings, and never echoes its ticket", async () => {
  const { server, subs, open } = harness();
  try {
    const ticket = mintLiveTicket(SECRET, ORIGIN).ticket;
    const client = open(`pool=${pool(1)}&resume=${pool(1)}~11:0:0:0`, ticket);
    assert.equal(await client.opened, true);
    assert.equal(client.ws.protocol, "blast-live.v1");
    await until(() => client.messages.length === 1);
    assert.equal(client.messages[0], 'event: status\ndata: {"state":"connecting"}\n\n');
    assert.equal(new URL(subs[0]!.url).searchParams.has("resume"), false, "the relay sees the plain SSE query");
    assert.deepEqual([...subs[0]!.resume!], [[pool(1), "11:0:0:0"]]);
    assert.equal(subs[0]!.lifetime, false);
    client.ws.send(JSON.stringify({ op: "ping", t: 123 }));
    await until(() => client.messages.length === 2);
    assert.match(client.messages[1]!, /^event: pong\ndata: \{"t":123,"server_ms":\d+\}\n\n$/);
    client.ws.send(JSON.stringify({ op: "ping", t: 124 }));
    assert.equal((await client.closed).code, LIVE_CLOSE.message, "more than one ping a second");
    await until(() => subs[0]!.stopped);

    const reused = open(`pool=${pool(1)}`, ticket);
    const refusal = await reused.closed;
    assert.equal(refusal.code, LIVE_CLOSE.ticket, "single use");
    assert.equal(refusal.reason.includes(ticket.slice(0, 16)), false);
  } finally {
    server.stop(true);
  }
});

test("admission refuses in order: origin before upgrade, then ticket, query, per-IP and Redis", async () => {
  const { server, open, url } = harness();
  try {
    assert.equal(await open(`pool=${pool(1)}`, undefined, "https://evil.test").opened, false);
    const plain = await fetch(url(`pool=${pool(1)}`).replace("ws:", "http:"), { headers: { Origin: ORIGIN, "Sec-WebSocket-Protocol": "blast-live.v1" } });
    assert.equal(plain.status, 426);
    assert.equal((await open(`pool=${pool(1)}`, "junk").closed).code, LIVE_CLOSE.ticket);
    assert.equal((await open(`pool=${pool(1)}&cursor=1:0:0:0`).closed).code, LIVE_CLOSE.query);
    assert.equal((await open(`pool=${pool(1)}&resume=${pool(2)}~1:0:0:0`).closed).code, LIVE_CLOSE.query, "resume must name a subscribed pool");
    const sockets = [];
    for (let i = 0; i < 4; i++) sockets.push(open(`pool=${pool(i + 1)}`));
    for (const socket of sockets) assert.equal(await socket.opened, true);
    assert.equal((await open(`pool=${pool(5)}`).closed).code, LIVE_CLOSE.perIp, "a fifth distinct pool from one address");
    const shared = open(`pool=${pool(1)}&${Array.from({ length: 20 }, (_, i) => `price_coin=${coin(i + 1)}`).join("&")}`);
    assert.equal(await shared.opened, true);
    await Bun.sleep(20);
    const coins = open(`pool=${pool(1)}&${Array.from({ length: 20 }, (_, i) => `price_coin=${coin(i + 21)}`).join("&")}`);
    await Bun.sleep(20);
    const tooMany = open(`pool=${pool(1)}&price_coin=${coin(99)}`);
    assert.equal((await tooMany.closed).code, LIVE_CLOSE.perIp, "the 41st distinct coin");
    for (const socket of [...sockets, shared, coins]) socket.ws.close();
  } finally {
    server.stop(true);
  }
  const down = harness(undefined, true);
  try {
    assert.equal((await down.open(`pool=${pool(1)}`).closed).code, LIVE_CLOSE.busy, "Redis down fails closed");
  } finally {
    down.server.stop(true);
  }
});

test("a full relay refuses with 4503 and drain closes sockets with 1012", async () => {
  const full = harness({ admits: () => false, subscribe: () => null });
  try {
    assert.equal((await full.open(`pool=${pool(1)}`).closed).code, LIVE_CLOSE.busy);
  } finally {
    full.server.stop(true);
  }
  const { live, server, subs, open } = harness();
  try {
    const client = open(`pool=${pool(1)}`);
    assert.equal(await client.opened, true);
    await until(() => subs.length === 1);
    await live.drain();
    assert.equal((await client.closed).code, LIVE_CLOSE.drain);
    assert.equal(subs[0]!.stopped, true);
    assert.equal(live.stats().sockets, 0);
  } finally {
    server.stop(true);
  }
});

test("the real relay serves a socket subscriber through an upstream frame", async () => {
  const upstream: RelaySocket & { sent: string[] } = {
    sent: [], onmessage: null, onclose: null, onerror: null,
    send(value) { this.sent.push(value); },
    close() {},
  };
  const relay = new MarketStreamRelay(() => upstream, { network: "mainnet", deployment: "a".repeat(64) });
  const { server, open } = harness(relay);
  try {
    const client = open("activity=true");
    assert.equal(await client.opened, true);
    await until(() => client.messages.some((message) => message.includes('"connecting"')));
  } finally {
    server.stop(true);
  }
});
