import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_STREAM_BUDGET } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { MarketStreamRelay, type MarketSubscription } from "./stream-relay.ts";
import type { RelaySocket } from "./stream-relay.ts";
import type { DisplayPriceReader } from "./display-price-feed.ts";

// A socket's `set` changes its pools, coins and presale in place: kept pools keep their fence.
const fingerprint = "a".repeat(64);
const key = (index: number) => `cetus:0x${index.toString(16).padStart(64, "0")}`;
const [A, B, C] = [key(1), key(2), key(3)];
const P1 = `0x${"7".repeat(64)}`;
const P2 = `0x${"8".repeat(64)}`;
const coin = (digit: string) => `0x${digit.repeat(64)}::coin::COIN`;
const provenance = (checkpoint: number) => ({
  network: "mainnet", deployment_fingerprint: fingerprint, checkpoint,
  timestamp_ms: checkpoint * 1_000, observed_ms: checkpoint * 1_000, lag_ms: 0,
});
const envelope = (checkpoint: number, cursor: string) => ({ checkpoint, timestamp_ms: checkpoint * 1_000, cursor, provenance: provenance(checkpoint) });
const snapshot = (pool: string, checkpoint: number) => ({ type: "snapshot", topic: `pool:${pool}`, ...envelope(checkpoint, `${checkpoint}:0:0:0`) });
const lifecycle = (pool: string, checkpoint: number) => ({ type: "lifecycle", pool_key: pool, ...envelope(checkpoint, `${checkpoint}:0:1:0`) });
const swap = (presale: string, checkpoint: number) => ({
  type: "presale_pool_swap", presale_id: presale, cursor: `${checkpoint}:0:0:0`, timestamp_ms: checkpoint * 1_000,
  coin_atoms: "5", quote_atoms: "7", pool_key: A, side: "buy",
});

class Socket implements RelaySocket {
  sent: Record<string, unknown>[] = [];
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() {}
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]);
  }
  drop() { this.onclose?.({} as Parameters<NonNullable<RelaySocket["onclose"]>>[0]); }
}

type Event = { event: string; data: Record<string, unknown> };

function harness(options: { maxClients?: number; prices?: DisplayPriceReader } = {}) {
  const sockets: Socket[] = [];
  const relay = new MarketStreamRelay(() => {
    sockets.push(new Socket());
    return sockets.at(-1)!;
  }, { network: "mainnet", deployment: fingerprint }, options.prices, options.maxClients);
  const join = (query: string) => {
    const events: Event[] = [];
    const sink = { full: false };
    const result = relay.subscribe(new Request(`https://frontend.test/api/launchpad/market/stream?${query}`), {
      send: (chunk) => {
        if (sink.full) return false;
        const text = new TextDecoder().decode(chunk);
        events.push({ event: text.match(/^event: (.+)$/m)![1]!, data: JSON.parse(text.match(/^data: (.+)$/m)![1]!) });
        return true;
      },
      close: () => {},
    });
    assert.ok(!(result instanceof Response), "admitted");
    /** The browser stops reading: the next send is refused and the relay drops the client. */
    const fill = () => { sink.full = true; };
    return { events, sub: result as MarketSubscription, fill };
  };
  const hello = (socket: Socket) => {
    socket.receive({ type: "hello", protocol: 1, provenance: provenance(1) });
    socket.receive({ type: "pong", activity_checkpoint: 3 });
  };
  /** Status and market frames since `from`, as `state@pool` and `market@pool`. */
  const seen = (events: Event[], from = 0) => events.slice(from)
    .filter(({ event }) => event === "status" || event === "market")
    .map(({ event, data }) => `${event === "status" ? data.state : "market"}@${data.pool_key ?? "-"}`);
  const ops = (socket: Socket, from = 0) => socket.sent.slice(from).filter(({ op }) => op !== "ping");
  return { relay, sockets, join, hello, seen, ops };
}

test("the hello hint tells a socket that it may send `set`", () => {
  const { sockets, join, hello } = harness();
  const client = join("activity=true");
  hello(sockets[0]!);
  assert.equal(client.events.find(({ data }) => data.type === "hello")?.data.set, true);
  client.sub.stop();
});

test("a removed pool stops streaming; its last client unsubscribes it upstream", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, seen, ops } = harness();
  const client = join(`pool=${A}&pool=${B}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(A, 10));
  sockets[0]!.receive(snapshot(B, 10));
  const sent = sockets[0]!.sent.length;
  client.sub.set({ pools: [B], priceCoins: [], presale: null });
  assert.deepEqual(ops(sockets[0]!, sent), [{ op: "unsubscribe", topics: [`pool:${A}`] }]);
  const from = client.events.length;
  sockets[0]!.receive(lifecycle(A, 11));
  sockets[0]!.receive(lifecycle(B, 11));
  assert.deepEqual(seen(client.events, from), [`market@${B}`]);
});

test("a swap at the cap joins the new pool and leaves the kept pool's fence alone", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, seen, ops } = harness();
  const client = join(`pool=${A}&pool=${B}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(A, 10));
  sockets[0]!.receive(snapshot(B, 10));
  const sent = sockets[0]!.sent.length;
  const from = client.events.length;
  client.sub.set({ pools: [A, C], priceCoins: [], presale: null });
  assert.deepEqual(ops(sockets[0]!, sent), [
    { op: "unsubscribe", topics: [`pool:${B}`] },
    { op: "subscribe", topics: [`pool:${C}`] },
  ]);
  sockets[0]!.receive(snapshot(C, 11));
  sockets[0]!.receive(lifecycle(A, 12));
  assert.deepEqual(seen(client.events, from), [`live@${C}`, `market@${A}`], "A gets no second fence");
  sockets[0]!.receive({ type: "pong", activity_checkpoint: 12 });
  t.mock.timers.tick(5_000);
  assert.deepEqual(seen(client.events, from).filter((entry) => entry.endsWith(`@${A}`) && !entry.startsWith("market")), [], "A is never re-fenced");
});

test("an added pool that another client already fenced is caught up at once", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, seen, ops } = harness();
  const holder = join(`pool=${B}`);
  const client = join(`pool=${A}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(B, 10));
  const sent = sockets[0]!.sent.length;
  const from = client.events.length;
  client.sub.set({ pools: [A, B], priceCoins: [], presale: null });
  assert.deepEqual(ops(sockets[0]!, sent), [], "B is already subscribed upstream");
  assert.deepEqual(seen(client.events, from), [`live@${B}`]);
  holder.sub.stop();
});

test("fits() has no client term and judges the shared tables after removals", () => {
  const capped = harness({ maxClients: 1 });
  const only = capped.join(`pool=${A}`);
  assert.equal(capped.relay.admits([B], []), false, "a new socket is refused at the client cap");
  assert.equal(capped.relay.fits([B], []), true, "a set on an existing socket is not");
  only.sub.stop();

  const { relay, join } = harness();
  const keys = Array.from({ length: MARKET_STREAM_BUDGET.maxTopics }, (_, index) => key(100 + index));
  const clients = Array.from({ length: keys.length / 2 }, (_, index) => join(`pool=${keys[2 * index]}&pool=${keys[2 * index + 1]}`));
  assert.equal(relay.fits([A], []), false, "64 topics are full");
  clients[0]!.sub.set({ pools: [keys[0]!], priceCoins: [], presale: null });
  assert.equal(relay.fits([A], []), true, "the removal made room");
  clients[0]!.sub.set({ pools: [keys[0]!, A], priceCoins: [], presale: null });
  assert.equal(relay.fits([B], []), false);
  assert.equal(relay.fits([A], []), true, "a pool the process holds costs no topic");
  for (const client of clients) client.sub.stop();
});

test("a pool added while the upstream reconnects is subscribed on the next hello and fences", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { sockets, join, hello, seen, ops } = harness();
  const client = join(`pool=${A}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(A, 10));
  sockets[0]!.drop();
  client.sub.set({ pools: [A, B], priceCoins: [], presale: null });
  assert.equal(sockets.length, 1, "no upstream message while it is down");
  t.mock.timers.tick(400);
  const from = client.events.length;
  hello(sockets[1]!);
  assert.ok(ops(sockets[1]!).some(({ op, topics }) => op === "subscribe" && (topics as string[]).includes(`pool:${B}`)));
  sockets[1]!.receive(snapshot(B, 12));
  assert.ok(seen(client.events, from).includes(`live@${B}`));
});

test("presale P1 -> P2 -> none moves the client and pongs the new presale", () => {
  const { sockets, join, hello } = harness();
  const client = join(`activity=true&presale=${P1}`);
  hello(sockets[0]!);
  const presales = () => client.events.filter(({ event }) => event === "presale").map(({ data }) => data.presale_id);
  const pongs = () => client.events.filter(({ data }) => data.type === "pong");
  sockets[0]!.receive(swap(P1, 20));
  assert.deepEqual(presales(), [P1]);
  const before = pongs().length;
  client.sub.set({ pools: [], priceCoins: [], presale: P2 });
  assert.equal(pongs().length, before + 1);
  assert.equal(pongs().at(-1)!.data.presale_checkpoint, 20);
  sockets[0]!.receive(swap(P1, 21));
  sockets[0]!.receive(swap(P2, 22));
  assert.deepEqual(presales(), [P1, P2]);
  client.sub.set({ pools: [], priceCoins: [], presale: null });
  sockets[0]!.receive(swap(P2, 23));
  assert.deepEqual(presales(), [P1, P2]);
  assert.equal(pongs().length, before + 1, "no pong for a removal");
  client.sub.stop();
});

test("a price-coin change reads the new list and does not re-send kept coins", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const reads: string[][] = [];
  const prices = ["1", "2", "3"].map((digit) => ({ coin_type: coin(digit), usd_price: "0.05", as_of_ms: 10_000 }));
  const { sockets, join, hello } = harness({
    prices: async (coins) => {
      reads.push([...coins]);
      return { checkpoint: 10 + reads.length, prices };
    },
  });
  const client = join(`activity=true&price_coin=${coin("1")}&price_coin=${coin("2")}`);
  hello(sockets[0]!);
  const sent = () => client.events.filter(({ event }) => event === "prices")
    .map(({ data }) => (data.prices as { coin_type: string }[]).map(({ coin_type }) => coin_type));
  const read = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  await read(1);
  assert.deepEqual(sent(), [[coin("1"), coin("2")]]);
  client.sub.set({ pools: [], priceCoins: [coin("2"), coin("3")], presale: null });
  await read(1_001);
  assert.deepEqual(reads.at(-1), [coin("2"), coin("3")]);
  assert.deepEqual(sent().at(-1), [coin("3")], "coin 2 was kept, so it is not sent again");
  client.sub.set({ pools: [], priceCoins: [], presale: null });
  const count = reads.length;
  await read(5_000);
  assert.equal(reads.length, count, "no coins left: no reads");
  client.sub.stop();
});

/** How many pool topics the process holds, read through `fits`. */
const topics = (relay: MarketStreamRelay) => {
  const fresh = Array.from({ length: MARKET_STREAM_BUDGET.maxTopics }, (_, index) => key(500 + index));
  let room = fresh.length;
  while (room && !relay.fits(fresh.slice(0, room), [])) room--;
  return fresh.length - room;
};

test("a client dropped by a refused send during set leaves no topic behind", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { relay, sockets, join, hello, ops } = harness();
  const holder = join(`pool=${B}`);
  const client = join(`pool=${A}`);
  hello(sockets[0]!);
  sockets[0]!.receive(snapshot(A, 10));
  sockets[0]!.receive(snapshot(B, 10));
  const sent = sockets[0]!.sent.length;
  client.fill();
  client.sub.set({ pools: [B, C], priceCoins: [], presale: null });
  assert.equal(ops(sockets[0]!, sent).some(({ op, topics }) => op === "subscribe" && (topics as string[]).includes(`pool:${C}`)), false, "B's refused catch-up dropped the client before C");
  assert.equal(topics(relay), 1, "only the holder's B is left");
  holder.sub.stop();
});

test("a client dropped by a refused presale pong during set joins no pool", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const { relay, sockets, join, hello } = harness();
  const holder = join(`pool=${B}`);
  const client = join(`activity=true&presale=${P1}`);
  hello(sockets[0]!);
  client.fill();
  client.sub.set({ pools: [A], priceCoins: [], presale: P2 });
  assert.equal(topics(relay), 1, "only the holder's B is left");
  holder.sub.stop();
});
