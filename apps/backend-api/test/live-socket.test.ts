import assert from "node:assert/strict";
import test from "node:test";
import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import type { HintSink } from "@blast/server/lib/hint-subscription.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { RelaySocket } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { MarketSet } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import {
  createLiveSocket,
  LIVE_CLOSE,
  LIVE_SOCKET,
  type LiveRelay,
  type LiveSocketData,
} from "../src/transport/live-socket.ts";

const SECRET = "s".repeat(48);
const ORIGIN = "https://blast.fun";
const pool = (index: number) => `blast_curve:0x${index.toString(16).padStart(64, "0")}`;
const coin = (index: number) => `0x${index.toString(16).padStart(64, "0")}::coin::COIN`;

type Sub = {
  url: string;
  sink: HintSink;
  resume?: ReadonlyMap<string, string>;
  stopped: boolean;
  sets: MarketSet[];
};

/** One Redis that every instance shares: burned tickets and the per-IP sets. */
const store = () => ({
  burned: new Set<string>(),
  ipSets: new Map<string, Set<string>>(),
  failedRemovals: 0,
  /** While set, the admit script waits for it: the socket is still in admission. */
  admitting: undefined as Promise<void> | undefined,
});

const DEV = { siteOrigin: "https://dev.blast.fun", namespace: "dev" };

function harness(
  relay?: LiveRelay,
  redisDown = false,
  shared = store(),
  extraSites = [DEV],
  drainMs?: number,
) {
  const { burned, ipSets } = shared;
  const ipSet = (key: string) => ipSets.get(key) ?? ipSets.set(key, new Set()).get(key)!;
  const subs: Sub[] = [];
  const room = { fits: true };
  const fake: LiveRelay = relay ?? {
    admits: () => true,
    fits: () => room.fits,
    subscribe(request, sink, options) {
      const sub: Sub = { url: request.url, sink, ...options, stopped: false, sets: [] };
      subs.push(sub);
      sink.send(new TextEncoder().encode('event: status\ndata: {"state":"connecting"}\n\n'));
      return {
        stop: () => {
          sub.stopped = true;
        },
        set: (next) => {
          sub.sets.push(next);
        },
      };
    },
  };
  const live = createLiveSocket({
    host: "127.0.0.1",
    siteOrigin: ORIGIN,
    gatewaySecret: SECRET,
    namespace: "test",
    extraSites,
    ingress: { mode: "direct" },
    relay: fake,
    drainMs,
    redis: {
      async execute(args: string[]) {
        if (redisDown) {
          throw new Error("down");
        }
        if (args[0] === "ZREM") {
          if (shared.failedRemovals > 0) {
            shared.failedRemovals--;
            throw new Error("deadline");
          }
          for (const id of args.slice(2)) {
            ipSet(args[1]!).delete(id);
          }
          return 1;
        }
        // EVALSHA admitScript: KEYS ticket, IP sockets, IP opens; ARGV ttl, id, socket cap, opens cap, life.
        assert.equal(args[0], "EVALSHA");
        await shared.admitting;
        const [ticketKey, socketsKey, opensKey, , id, socketCap, opensCap] = args.slice(3);
        const site = ticketKey!.split(":")[0]!;
        assert.match(ticketKey!, /^(test|dev):live-ticket:/);
        assert.equal(socketsKey!, `${site}:live-ip:sockets:${socketsKey!.split(":").at(-1)}`);
        assert.equal(opensKey!, `${site}:live-ip:opens:${opensKey!.split(":").at(-1)}`);
        const open = ipSet(socketsKey!);
        const opens = ipSet(opensKey!);
        if (open.size >= Number(socketCap) || opens.size >= Number(opensCap)) {
          return 2;
        }
        if (burned.has(ticketKey!)) {
          return 0;
        }
        burned.add(ticketKey!);
        open.add(id!);
        opens.add(id!);
        return 1;
      },
    },
  });
  const server = Bun.serve<LiveSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    websocket: live.websocket,
    fetch(request, native) {
      return (
        live.upgrade(request, native, native.requestIP(request)?.address ?? null) ??
        new Response(null)
      );
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
  return { live, server, subs, open, url, burned, room };
}

type Client = ReturnType<ReturnType<typeof harness>["open"]>;
type Answer = {
  seq: number;
  ok: boolean;
  reason?: string;
  retry_ms?: number;
  held: { pools: string[]; price_coins: string[]; presale: string | null };
};

const sendSet = (
  client: Client,
  seq: number,
  pools: string[],
  priceCoins: string[] = [],
  presale: string | null = null,
) => client.ws.send(JSON.stringify({ op: "set", seq, pools, price_coins: priceCoins, presale }));
const answers = (client: Client): Answer[] =>
  client.messages
    .filter((message) => message.startsWith("event: set\n"))
    .map((message) => JSON.parse(message.slice("event: set\ndata: ".length)));
/** Sends one `set` and waits for its answer. */
const set = async (client: Client, seq: number, pools: string[], priceCoins: string[] = []) => {
  const before = answers(client).length;
  sendSet(client, seq, pools, priceCoins);
  await until(() => answers(client).length > before);
  const answer = answers(client).at(-1)!;
  assert.equal(answer.seq, seq);
  return answer;
};
const admitted = (client: Client) => until(() => client.messages.length > 0);

const until = async (check: () => boolean, ms = 1_000) => {
  for (let i = 0; i < ms / 5 && !check(); i++) {
    await Bun.sleep(5);
  }
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
    assert.equal(
      new URL(subs[0]!.url).searchParams.has("resume"),
      false,
      "the relay sees the plain market query",
    );
    assert.deepEqual([...subs[0]!.resume!], [[pool(1), "11:0:0:0"]]);
    client.ws.send(JSON.stringify({ op: "ping", t: 123 }));
    await until(() => client.messages.length === 2);
    assert.match(client.messages[1]!, /^event: pong\ndata: \{"t":123,"server_ms":\d+\}\n\n$/);
    client.ws.send(JSON.stringify({ op: "ping", t: 124 }));
    assert.equal((await client.closed).code, LIVE_CLOSE.message, "more than one ping a second");
    await until(() => subs[0]!.stopped);

    const reused = open(`pool=${pool(1)}`, ticket);
    const refusal = await reused.closed;
    assert.equal(refusal.code, LIVE_CLOSE.ticket, "single use");
    assert.equal(
      reused.messages.at(-1),
      `event: close\ndata: {"code":${LIVE_CLOSE.ticket}}\n\n`,
      "the last frame names the code",
    );
    assert.equal(refusal.reason.includes(ticket.slice(0, 16)), false);
  } finally {
    server.stop(true);
  }
});

test("admission refuses in order: origin before upgrade, then ticket, query, per-IP and Redis", async () => {
  const { server, open, url } = harness();
  try {
    assert.equal(await open(`pool=${pool(1)}`, undefined, "https://evil.test").opened, false);
    const plain = await fetch(url(`pool=${pool(1)}`).replace("ws:", "http:"), {
      headers: { Origin: ORIGIN, "Sec-WebSocket-Protocol": "blast-live.v1" },
    });
    assert.equal(plain.status, 426);
    assert.equal((await open(`pool=${pool(1)}`, "junk").closed).code, LIVE_CLOSE.ticket);
    assert.equal((await open(`pool=${pool(1)}&cursor=1:0:0:0`).closed).code, LIVE_CLOSE.query);
    assert.equal(
      (await open(`pool=${pool(1)}&resume=${pool(2)}~1:0:0:0`).closed).code,
      LIVE_CLOSE.query,
      "resume must name a subscribed pool",
    );
    const sockets = [];
    for (let i = 0; i < 4; i++) {
      sockets.push(open(`pool=${pool(i + 1)}`));
    }
    for (const socket of sockets) {
      assert.equal(await socket.opened, true);
    }
    assert.equal(
      (await open(`pool=${pool(5)}`).closed).code,
      LIVE_CLOSE.perIp,
      "a fifth distinct pool from one address",
    );
    const shared = open(
      `pool=${pool(1)}&${Array.from({ length: 20 }, (_, i) => `price_coin=${coin(i + 1)}`).join("&")}`,
    );
    assert.equal(await shared.opened, true);
    await Bun.sleep(20);
    const coins = open(
      `pool=${pool(1)}&${Array.from({ length: 20 }, (_, i) => `price_coin=${coin(i + 21)}`).join("&")}`,
    );
    await Bun.sleep(20);
    const tooMany = open(`pool=${pool(1)}&price_coin=${coin(99)}`);
    assert.equal((await tooMany.closed).code, LIVE_CLOSE.perIp, "the 41st distinct coin");
    for (const socket of [...sockets, shared, coins]) {
      socket.ws.close();
    }
  } finally {
    server.stop(true);
  }
  const down = harness(undefined, true);
  try {
    assert.equal(
      (await down.open(`pool=${pool(1)}`).closed).code,
      LIVE_CLOSE.busy,
      "Redis down fails closed",
    );
  } finally {
    down.server.stop(true);
  }
});

test("a full relay refuses with 4503 and drain closes sockets with 1012", async () => {
  const full = harness({
    admits: () => false,
    fits: () => false,
    subscribe: () => assert.fail("refused before subscribing"),
  });
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
    sent: [],
    onmessage: null,
    onclose: null,
    onerror: null,
    send(value) {
      this.sent.push(value);
    },
    close() {},
  };
  const relay = new MarketStreamRelay(() => upstream, {
    network: "mainnet",
    deployment: "a".repeat(64),
  });
  const { server, open } = harness(relay);
  try {
    const client = open("activity=true");
    assert.equal(await client.opened, true);
    await until(() => client.messages.some((message) => message.includes('"connecting"')));
  } finally {
    server.stop(true);
  }
});

test("per-IP socket and open counts are shared by every instance", async () => {
  const shared = store();
  const a = harness(undefined, false, shared);
  const b = harness(undefined, false, shared);
  try {
    const held = [];
    for (let i = 0; i < 8; i++) {
      const client = (i % 2 ? b : a).open(`pool=${pool(1)}`);
      assert.equal(await client.opened, true);
      held.push(client);
    }
    await Bun.sleep(20);
    assert.equal(
      (await a.open(`pool=${pool(1)}`).closed).code,
      LIVE_CLOSE.perIp,
      "the ninth socket from one address, on either instance",
    );
    // The first removal fails, as on a Redis stall: the retry still frees the slot.
    shared.failedRemovals = 1;
    held.pop()!.ws.close();
    await Bun.sleep(50);
    assert.ok(
      [...shared.ipSets.values()].some((set) => set.size === 8),
      "the failed removal",
    );
    await until(() => [...shared.ipSets.values()].some((set) => set.size === 7), 3_000);
    const again = a.open(`pool=${pool(1)}`);
    assert.equal(await again.opened, true);
    await Bun.sleep(20);
    assert.equal(again.ws.readyState, WebSocket.OPEN, "a closed socket frees its shared slot");
    for (const client of [...held, again]) {
      client.ws.close();
    }
  } finally {
    a.server.stop(true);
    b.server.stop(true);
  }
});

test("an extra site opens with its own ticket origin and namespace; others stay refused", async () => {
  const devTicket = () => mintLiveTicket(SECRET, DEV.siteOrigin).ticket;
  const unset = harness(undefined, false, store(), []);
  try {
    assert.equal(
      await unset.open(`pool=${pool(1)}`, devTicket(), DEV.siteOrigin).opened,
      false,
      "unset: only the primary origin upgrades",
    );
  } finally {
    unset.server.stop(true);
  }
  const { server, open, burned } = harness();
  try {
    const dev = open(`pool=${pool(1)}`, devTicket(), DEV.siteOrigin);
    assert.equal(await dev.opened, true);
    await until(() => [...burned].some((key) => key.startsWith("dev:live-ticket:")));
    assert.equal(
      (await open(`pool=${pool(1)}`, mintLiveTicket(SECRET, ORIGIN).ticket, DEV.siteOrigin).closed)
        .code,
      LIVE_CLOSE.ticket,
      "a primary ticket is not valid on the dev origin",
    );
    assert.equal(
      (await open(`pool=${pool(1)}`, devTicket(), ORIGIN).closed).code,
      LIVE_CLOSE.ticket,
      "a dev ticket is not valid on the primary origin",
    );
    assert.equal(await open(`pool=${pool(1)}`, devTicket(), "https://evil.test").opened, false);
    const primary = open(`pool=${pool(2)}`);
    assert.equal(await primary.opened, true);
    await until(() => [...burned].some((key) => key.startsWith("test:live-ticket:")));
    dev.ws.close();
    primary.ws.close();
  } finally {
    server.stop(true);
  }
});

test("a set on the real relay is answered before the added pool's catch-up, then streams", async () => {
  const fingerprint = "a".repeat(64);
  const provenance = (checkpoint: number) => ({
    network: "mainnet",
    deployment_fingerprint: fingerprint,
    checkpoint,
    timestamp_ms: checkpoint * 1_000,
    observed_ms: checkpoint * 1_000,
    lag_ms: 0,
  });
  const envelope = (checkpoint: number, cursor: string) => ({
    checkpoint,
    timestamp_ms: checkpoint * 1_000,
    cursor,
    provenance: provenance(checkpoint),
  });
  const upstream: RelaySocket & { sent: string[]; receive(frame: object): void } = {
    sent: [],
    onmessage: null,
    onclose: null,
    onerror: null,
    send(value) {
      this.sent.push(value);
    },
    close() {},
    receive(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) } as never);
    },
  };
  const relay = new MarketStreamRelay(() => upstream, {
    network: "mainnet",
    deployment: fingerprint,
  });
  const holder = relay.subscribe(new Request(`https://live.internal/s?pool=${pool(2)}`), {
    send: () => true,
    close() {},
  });
  assert.ok(!(holder instanceof Response));
  const { server, open } = harness(relay);
  try {
    const client = open(`activity=true&pool=${pool(1)}`);
    assert.equal(await client.opened, true);
    await until(() => client.messages.some((message) => message.includes('"connecting"')));
    upstream.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    upstream.receive({ type: "pong" });
    upstream.receive({ type: "snapshot", topic: `pool:${pool(2)}`, ...envelope(10, "10:0:0:0") });
    await until(() => client.messages.some((message) => message.includes('"set":true')));
    const answer = await set(client, 7, [pool(1), pool(2)]);
    assert.deepEqual(answer, {
      seq: 7,
      ok: true,
      held: { pools: [pool(1), pool(2)], price_coins: [], presale: null },
    });
    await until(() =>
      client.messages.some((message) => message.includes(`"pool_key":"${pool(2)}"`)),
    );
    const order = client.messages.findIndex((message) => message.startsWith("event: set"));
    const live = client.messages.findIndex(
      (message) => message.includes('"state":"live"') && message.includes(pool(2)),
    );
    assert.ok(order >= 0 && order < live, "the answer comes before the pool's fence");
    upstream.receive({ type: "lifecycle", pool_key: pool(2), ...envelope(11, "11:0:1:0") });
    await until(() => client.messages.some((message) => message.startsWith("id: 11:0:1:0")));
    assert.equal(client.ws.readyState, WebSocket.OPEN);
    client.ws.close();
  } finally {
    holder.stop();
    server.stop(true);
  }
});

test("an open whose pools stopped fitting while Redis answered closes busy and holds nothing", async () => {
  const shared = store();
  let admit!: () => void;
  shared.admitting = new Promise((resolve) => {
    admit = resolve;
  });
  const { live, server, subs, open, room } = harness(undefined, false, shared);
  try {
    const client = open(`pool=${pool(1)}&price_coin=${coin(1)}`);
    // Room at the first check; the tables fill while Redis answers.
    await until(() => live.stats().addresses === 1);
    room.fits = false;
    admit();
    assert.equal((await client.closed).code, LIVE_CLOSE.busy);
    assert.equal(subs.length, 0, "never subscribed");
    await until(() => live.stats().addresses === 0 && live.stats().sockets === 0);
  } finally {
    server.stop(true);
  }
});

test("a set past the per-IP pools is refused after its removals; a full process says busy", async () => {
  const { live, server, subs, open, room } = harness();
  try {
    // Admitted one at a time, so subs[i] is client i.
    const one = open(`pool=${pool(1)}&pool=${pool(2)}`);
    await admitted(one);
    const two = open(`pool=${pool(3)}&pool=${pool(4)}`);
    await admitted(two);
    const three = open(`activity=true&price_coin=${coin(1)}`);
    await admitted(three);
    const refused = await set(three, 1, [pool(5)]);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "per_ip");
    assert.equal(refused.retry_ms, 60_000);
    assert.deepEqual(
      refused.held,
      { pools: [], price_coins: [], presale: null },
      "the coin removal applied",
    );
    assert.deepEqual(subs[2]!.sets, [{ pools: [], priceCoins: [], presale: null }]);
    assert.equal(one.ws.readyState, WebSocket.OPEN);
    assert.equal(subs[0]!.sets.length, 0, "other sockets keep their pools");

    // A swap at the per-IP cap is fine: removals come first.
    assert.equal((await set(two, 1, [pool(3), pool(5)])).ok, true);
    assert.deepEqual(subs[1]!.sets.at(-1), {
      pools: [pool(3), pool(5)],
      priceCoins: [],
      presale: null,
    });

    room.fits = false;
    const busy = await set(two, 2, [pool(3), pool(6)]);
    assert.deepEqual(
      { ok: busy.ok, reason: busy.reason, retry_ms: busy.retry_ms, held: busy.held.pools },
      { ok: false, reason: "busy", retry_ms: 5_000, held: [pool(3)] },
    );
    for (const client of [one, two, three]) {
      client.ws.close();
    }
    await until(() => live.stats().addresses === 0 && live.stats().sockets === 0);
  } finally {
    server.stop(true);
  }
});

test("one address adds at most 40 pools a minute; one socket sends at most 10 sets a minute, then one refusal", async () => {
  const { live, server, open } = harness();
  try {
    const [one, two, three] = [open("activity=true"), open("activity=true"), open("activity=true")];
    for (const client of [one, two, three]) {
      await admitted(client);
    }
    for (let i = 1; i <= LIVE_SOCKET.setsPerMinute; i++) {
      assert.equal((await set(one, i, [pool(10 + 2 * i), pool(11 + 2 * i)])).ok, true);
    }
    const rate = await set(one, 11, []);
    assert.equal(rate.reason, "rate");
    assert.ok(rate.retry_ms! > 0 && rate.retry_ms! <= 60_000);
    assert.equal(rate.held.pools.length, 2, "a rate refusal changes nothing");
    sendSet(one, 12, []);
    assert.equal((await one.closed).code, LIVE_CLOSE.message, "a second set over the rate closes");
    for (let i = 1; i < 10; i++) {
      assert.equal((await set(two, i, [pool(100 + 2 * i), pool(101 + 2 * i)])).ok, true);
    }
    assert.equal((await set(two, 10, [pool(200)])).ok, true);
    assert.equal((await set(three, 1, [pool(300)])).ok, true, "the 40th added pool");
    const churn = await set(three, 2, [pool(301)]);
    assert.equal(churn.reason, "churn", "the 41st");
    assert.ok(churn.retry_ms! > 0 && churn.retry_ms! <= 60_000);
    assert.deepEqual(churn.held.pools, [], "its removal applied");
    for (const client of [one, two, three]) {
      client.ws.close();
    }
    await until(() => live.stats().addresses === 0);
    const again = open("activity=true");
    await admitted(again);
    assert.equal(
      (await set(again, 1, [pool(400)])).reason,
      "churn",
      "closing every socket does not reset the window",
    );
    again.ws.close();
    await until(() => live.stats().addresses === 0);
  } finally {
    server.stop(true);
  }
});

test("a set during admission closes 1008 and leaves no tables; while draining it is busy", async () => {
  const shared = store();
  let admit!: () => void;
  shared.admitting = new Promise((resolve) => {
    admit = resolve;
  });
  const { live, server, open } = harness(undefined, false, shared, [DEV], 2_000);
  const random = Math.random;
  try {
    const early = open(`pool=${pool(1)}`);
    assert.equal(await early.opened, true);
    sendSet(early, 1, [pool(1), pool(2)]);
    assert.equal((await early.closed).code, LIVE_CLOSE.message);
    admit();
    shared.admitting = undefined;
    await until(() => live.stats().addresses === 0 && live.stats().sockets === 0);
    await until(() =>
      [...shared.ipSets].every(([key, ids]) => !key.includes(":sockets:") || ids.size === 0),
    );

    const client = open(`pool=${pool(1)}`);
    await admitted(client);
    Math.random = () => 0.99;
    const draining = live.drain();
    const answer = await set(client, 2, [pool(1), pool(2)]);
    assert.deepEqual(
      { ok: answer.ok, reason: answer.reason, retry_ms: answer.retry_ms },
      { ok: false, reason: "busy", retry_ms: 5_000 },
    );
    assert.equal((await client.closed).code, LIVE_CLOSE.drain);
    await draining;
  } finally {
    Math.random = random;
    server.stop(true);
  }
});

test("bad set frames close 1008", async () => {
  const { server, open } = harness();
  try {
    const frames = [
      { op: "set", seq: 1, pools: [], price_coins: [], presale: null, extra: 1 },
      { op: "set", seq: 1, pools: ["not-a-pool"], price_coins: [], presale: null },
      { op: "set", seq: 1, pools: [pool(1), pool(2), pool(3)], price_coins: [], presale: null },
      { op: "set", seq: 1, pools: [pool(1), pool(1)], price_coins: [], presale: null },
      { op: "set", seq: 1, pools: [], price_coins: [], presale: "nope" },
      { op: "set", seq: 1.5, pools: [], price_coins: [], presale: null },
      { op: "set", seq: 1, pools: [], price_coins: [] },
      { op: "set", seq: 1, pools: [`${pool(1)}&pool=${pool(2)}`], price_coins: [], presale: null },
      { op: "set", seq: 1, pools: [[pool(1)]], price_coins: [], presale: null },
    ];
    for (const frame of frames) {
      const client = open(`pool=${pool(1)}`);
      await admitted(client);
      client.ws.send(JSON.stringify(frame));
      assert.equal((await client.closed).code, LIVE_CLOSE.message, JSON.stringify(frame));
    }
  } finally {
    server.stop(true);
  }
});
