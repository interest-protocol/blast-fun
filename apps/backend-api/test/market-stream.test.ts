import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_STREAM_BUDGET as B,
  MARKET_STREAM_PATH,
  marketStreamPools,
} from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { MarketStreamRelay } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import type { RelaySocket } from "@blast/server/modules/launchpad-market/stream-relay.ts";
import {
  infraProvenanceFixture,
  FIXTURE_FINGERPRINT,
  poolSummaryFixture,
} from "../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { validateBackendFleet } from "../src/app/config/fleet.ts";
import { fleetFixture } from "./fleet-fixture.ts";

const expected = {
  network: "mainnet",
  deployment: FIXTURE_FINGERPRINT,
} as const;
const pool = (index = 1) => `blast_curve:0x${index.toString(16).padStart(64, "0")}`;
const request = (pools = [pool()]) =>
  new Request(
    `https://frontend.test${MARKET_STREAM_PATH}?${new URLSearchParams(pools.map((value) => ["pool", value]))}`,
  );
const provenance = (checkpoint = 10) =>
  infraProvenanceFixture({ checkpoint, timestamp_ms: checkpoint * 1000 });
const frame = (type: string, checkpoint = 10, fields: Record<string, unknown> = {}) => ({
  type,
  cursor: `${checkpoint}:1:1:0`,
  checkpoint,
  timestamp_ms: checkpoint * 1000,
  provenance: provenance(checkpoint),
  ...fields,
});
const snapshot = (key = pool(), checkpoint = 10) =>
  frame("snapshot", checkpoint, { topic: `pool:${key}` });
const trade = (checkpoint = 11, key = pool()) => ({
  ...frame("trade", checkpoint),
  trade: {
    cursor: `${checkpoint}:1:1:0`,
    checkpoint,
    timestamp_ms: checkpoint * 1000,
    pool_key: key,
    side: "buy",
    kind: "buy",
    price: "0.000000000000000000000000000000000001",
    quote_amount: "9007199254740993",
    meme_amount: "123",
    volume_usd: "1.25",
    labels: ["whale"],
  },
});

class Socket implements RelaySocket {
  sent: Record<string, unknown>[] = [];
  closed = 0;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(value: string) {
    assert.ok(new TextEncoder().encode(value).byteLength <= 4096);
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closed++;
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as Parameters<
      NonNullable<RelaySocket["onmessage"]>
    >[0]);
  }
  hello() {
    this.receive({ type: "hello", protocol: 1, provenance: provenance() });
  }
}

/** One socket client's SSE blocks as a byte-bounded stream; a refusal is its error response. */
function open(relay: MarketStreamRelay, target: Request): Response {
  let stop: (() => void) | undefined;
  let refusal: Response | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const subscription = relay.subscribe(target, {
          send(chunk) {
            if ((controller.desiredSize ?? 0) < chunk.byteLength) {
              return false;
            }
            controller.enqueue(chunk);
            return true;
          },
          close() {
            if (!cancelled) {
              controller.close();
            }
          },
        });
        if (subscription instanceof Response) {
          refusal = subscription;
        } else {
          stop = subscription;
        }
      },
      cancel() {
        cancelled = true;
        stop?.();
      },
    },
    { highWaterMark: B.queueBytesPerClient, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return refusal ?? new Response(body);
}

const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const value = await reader.read();
  assert.equal(value.done, false);
  const text = new TextDecoder().decode(value.value);
  return {
    text,
    event: text.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(text.match(/^data: (.+)$/m)![1]!) as Record<string, unknown>,
  };
};

test("an unpriced fill reaches live clients and is preserved in the next subscriber's fence", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const live = open(relay, request()).body!.getReader();
  try {
    await read(live);
    socket.hello();
    socket.receive(snapshot());
    await read(live);
    const fill = trade();
    socket.receive({ ...fill, trade: { ...fill.trade, price: null } });
    const received = await read(live);
    assert.equal(received.event, "market");
    assert.equal((received.data.trade as { price: unknown }).price, null);

    const later = open(relay, request()).body!.getReader();
    try {
      await read(later);
      assert.equal((await read(later)).data.price_missing, true);
    } finally {
      await later.cancel();
    }
  } finally {
    await live.cancel();
  }
});

test("a market subscription names one or two canonical pools", () => {
  assert.deepEqual(marketStreamPools(request([pool(), pool(2)])), [pool(), pool(2)]);
  for (const query of [
    "",
    "pool=feed",
    `pool=${pool()}&pool=${pool()}`,
    `pool=${pool()}&pool=${pool(2)}&pool=${pool(3)}`,
    `pool=${pool()}&wallet=x`,
    `pool=${pool()}&cursor=invalid`,
  ]) {
    assert.throws(() =>
      marketStreamPools(new Request(`https://frontend.test${MARKET_STREAM_PATH}?${query}`)),
    );
  }
});

test("presale clients share the socket and receive only their fills beyond a scoped fence", async () => {
  const sale = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;
  const scoped = (id: string) =>
    new Request(`https://frontend.test${MARKET_STREAM_PATH}?presale=${id}`);
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const a = open(relay, scoped(sale(1))).body!.getReader();
  await read(a);
  socket.hello();
  await read(a);
  assert.deepEqual(socket.sent[0], { op: "subscribe", topics: ["activity"] });
  socket.receive({ type: "pong", activity_checkpoint: 12 });
  assert.equal((await read(a)).data.presale_checkpoint, 12);
  const fill = {
    type: "presale_pool_swap",
    presale_id: sale(1),
    pool_key: `bluefin:${sale(3)}`,
    cursor: "13:0:3:0",
    timestamp_ms: 13_000,
    side: "sell",
    coin_atoms: "9007199254740993",
    quote_atoms: "41",
  };
  socket.receive({ ...fill, internal: "discard" });
  const frame = await read(a);
  assert.equal(frame.event, "presale");
  assert.deepEqual(frame.data, fill);
  const b = open(relay, scoped(sale(2))).body!.getReader();
  await read(b);
  await read(b);
  assert.equal((await read(b)).data.presale_checkpoint, 13);
  socket.receive({ ...fill, cursor: "14:0:3:0" });
  socket.receive({ ...fill, presale_id: sale(2), cursor: "15:0:3:0" });
  assert.equal((await read(a)).data.cursor, "14:0:3:0");
  assert.equal((await read(b)).data.cursor, "15:0:3:0");
  await a.cancel();
  await b.cancel();
});

test("one socket shares pool topics, committed fences and precise replay-shaped trades across clients", async () => {
  const socket = new Socket();
  let opened = 0;
  const relay = new MarketStreamRelay(() => {
    opened++;
    return socket;
  }, expected);
  const a = open(relay, request()).body!.getReader();
  const b = open(relay, request()).body!.getReader();
  assert.equal(opened, 1);
  await read(a);
  await read(b);
  socket.hello();
  assert.deepEqual(socket.sent[0], {
    op: "subscribe",
    topics: ["activity", `pool:${pool()}`],
  });
  socket.receive(snapshot());
  assert.equal((await read(a)).data.checkpoint, 10);
  await read(b);
  const value = trade();
  value.cursor = "11:1:1:2"; // Lifecycle messages may precede the trade's outer part.
  socket.receive(value);
  const first = await read(a);
  const second = await read(b);
  assert.equal(first.event, "market");
  assert.equal(first.text, second.text);
  assert.match(first.text, /^id: 11:1:1:2/m);
  assert.equal(JSON.stringify(first.data).includes("labels"), false);
  assert.equal((first.data.trade as Record<string, unknown>).quote_amount, "9007199254740993");
  const late = open(relay, request([pool(), pool(2)])).body!.getReader();
  assert.equal((await read(late)).data.state, "connecting");
  assert.equal(
    (await read(late)).data.checkpoint,
    11,
    "late join fence covers every prejoin trade",
  );
  assert.deepEqual(socket.sent.at(-1), {
    op: "subscribe",
    topics: [`pool:${pool(2)}`],
  });
  socket.receive(snapshot(pool(2), 12));
  assert.equal((await read(late)).data.pool_key, pool(2));
  await late.cancel();
  assert.deepEqual(socket.sent.at(-1), {
    op: "unsubscribe",
    topics: [`pool:${pool(2)}`],
  });
  await a.cancel();
  assert.equal(socket.closed, 0);
  await b.cancel();
  assert.equal(socket.closed, 1);
});

test("a pool the engine never snapshots re-fences only itself and never resets other pools", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const served = open(relay, request()).body!.getReader();
  const original = globalThis.setTimeout;
  const timers: { run: () => void; ms: number }[] = [];
  globalThis.setTimeout = ((run: () => void, ms: number) => {
    timers.push({ run, ms });
    return original(() => {}, 3_600_000);
  }) as typeof setTimeout;
  let stalled: ReadableStreamDefaultReader<Uint8Array>;
  try {
    stalled = open(relay, request([pool(2)])).body!.getReader();
    await read(served);
    await read(stalled);
    // A slow upstream handshake is the handshake timer's fault, never a pool's.
    assert.equal(
      timers.some(({ ms }) => ms === 10_000),
      false,
    );
    socket.hello();
  } finally {
    globalThis.setTimeout = original;
  }
  try {
    socket.receive({ type: "pong" });
    socket.receive(snapshot());
    assert.equal((await read(served)).data.pool_key, pool());
    // The engine sends nothing for pool 2 (for example a coin it does not index).
    const deadlines = timers.filter(({ ms }) => ms === 10_000);
    assert.equal(deadlines.length, 2, "each pool's deadline starts at the upstream subscribe");
    deadlines.at(-1)!.run();
    const recovering = await read(stalled);
    assert.equal(recovering.event, "status");
    assert.deepEqual(recovering.data, { state: "recovering", pool_key: pool(2) });
    await new Promise((resolve) => original(resolve, 0));
    // The reader took the subscribe: the pool stays subscribed for the next traffic; the browser keeps its stream.
    assert.equal(socket.sent.some((op) => op.op === "unsubscribe"), false);
    assert.equal(socket.closed, 0);
    socket.receive(trade());
    assert.equal((await read(served)).event, "market");
  } finally {
    await served.cancel();
  }
});

test("authoritative closed candles retain exact decimals and bounded representative snapshots stay upstream-only", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const reader = open(relay, request()).body!.getReader();
  await read(reader);
  socket.hello();
  const example = snapshot() as Record<string, unknown>;
  example.summary = poolSummaryFixture();
  example.trades = Array.from({ length: 50 }, (_, i) => ({
    ...trade().trade,
    cursor: `9:1:${i}:0`,
    inputs: {
      virtual_quote: "1500000000000",
      meme_reserve: "696000000000000",
      quote_reserve: "260000000000",
      graduation_target: "3000000000000",
      meme_decimals: "6",
      quote_decimals: "9",
    },
    curve: {
      protocol_meme_fee_delta: "20000000000",
      creator_meme_fee_delta: "20000000000",
    },
  }));
  assert.ok(JSON.stringify(example).length < B.maxUpstreamFrameChars);
  socket.receive(example);
  const live = await read(reader);
  assert.equal(live.event, "status");
  assert.equal("trades" in live.data, false);
  const candle = {
    bucket_start: 10000,
    interval: "1s",
    open: "0.1",
    high: "0.2",
    low: "0.1",
    close: "0.2",
    volume_quote: "9007199254740993",
    volume_meme: "4",
    volume_usd: "1.25",
    buys: 1,
    sells: 0,
    trades: 1,
  };
  socket.receive(frame("candle_closed", 11, { pool_key: pool(), interval: "1s", candle }));
  assert.deepEqual((await read(reader)).data.candle, candle);
  await reader.cancel();
});

const openingRound = (bidders = 3) => ({
  duration_ms: "3600000",
  starts_at_ms: "1790000000000",
  ends_at_ms: "1790003600000",
  total_committed_quote: "9007199254740993",
  bidder_count: bidders,
  settlement: null,
  delivered_count: 0,
  undelivered_count: bidders,
  state: "open",
});

test("an opening round frame reaches the pool's clients as a market event with its exact round", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const reader = open(relay, request()).body!.getReader();
  await read(reader);
  socket.hello();
  socket.receive(snapshot());
  await read(reader);
  socket.receive(frame("opening_round", 11, { pool_key: pool(), opening_round: openingRound(3) }));
  const live = await read(reader);
  assert.equal(live.event, "market");
  assert.match(live.text, /^id: 11:1:1:0/m);
  assert.deepEqual(live.data.opening_round, openingRound(3));
  socket.receive({
    ...frame("opening_round", 12, { pool_key: pool(), opening_round: openingRound(4) }),
    cursor: "12:2:0:0",
  });
  assert.equal(
    ((await read(reader)).data.opening_round as Record<string, unknown>).bidder_count,
    4,
  );
  // A bid's trade, its round, then a later trade of the same checkpoint: each has its own cursor.
  const tradeAt = (cursor: string) => ({
    ...trade(13),
    cursor,
    trade: { ...trade(13).trade, cursor },
  });
  socket.receive(tradeAt("13:1:1:0"));
  socket.receive({
    ...frame("opening_round", 13, { pool_key: pool(), opening_round: openingRound(5) }),
    cursor: "13:1:2:0",
  });
  socket.receive(tradeAt("13:1:3:0"));
  const sequence = [await read(reader), await read(reader), await read(reader)];
  assert.deepEqual(
    sequence.map((event) => [event.data.type, event.data.cursor]),
    [
      ["trade", "13:1:1:0"],
      ["opening_round", "13:1:2:0"],
      ["trade", "13:1:3:0"],
    ],
  );
  await reader.cancel();
});

test("bad cursor relationships and opening fills re-fence the pool; another deployment and lost continuity force explicit recovery", async () => {
  const invalid: Array<(socket: Socket) => void> = [
    (s) => s.receive({ ...trade(), provenance: provenance(99) }),
    (s) =>
      s.receive({
        ...trade(),
        trade: { ...trade().trade, cursor: "11:1:1:9" },
      }),
    (s) =>
      s.receive({
        ...trade(),
        trade: { ...trade().trade, cursor: "11:1:2:0" },
      }),
    (s) =>
      s.receive({
        ...trade(),
        trade: { ...trade().trade, kind: "opening_round_fill" },
      }),
    (s) =>
      s.receive(
        frame("opening_round", 11, {
          pool_key: pool(),
          opening_round: { ...openingRound(3), undelivered_count: 2 },
        }),
      ),
    (s) => s.receive(frame("opening_round", 11, { pool_key: pool() })),
  ];
  for (const bad of invalid) {
    const socket = new Socket();
    const relay = new MarketStreamRelay(() => socket, expected);
    const reader = open(relay, request()).body!.getReader();
    await read(reader);
    socket.hello();
    socket.receive(snapshot());
    await read(reader);
    bad(socket);
    const status = await read(reader);
    assert.equal(status.event, "status");
    assert.deepEqual(status.data, { state: "recovering", pool_key: pool() });
    assert.equal(socket.closed, 0);
    await reader.cancel();
  }
  {
    // A frame from another deployment means the relay is wired to the wrong reader.
    const socket = new Socket();
    const relay = new MarketStreamRelay(() => socket, expected);
    const reader = open(relay, request()).body!.getReader();
    await read(reader);
    socket.hello();
    socket.receive(snapshot());
    await read(reader);
    socket.receive({
      ...trade(),
      provenance: { ...provenance(11), deployment_fingerprint: "f".repeat(64) },
    });
    assert.equal((await read(reader)).event, "resync");
    assert.equal((await reader.read()).done, true);
    assert.equal(socket.closed, 1);
    await reader.cancel();
  }
  {
    // A frame no pool can be blamed for reconnects the upstream; the browser stays.
    const socket = new Socket();
    const relay = new MarketStreamRelay(() => socket, expected);
    const reader = open(relay, request()).body!.getReader();
    await read(reader);
    socket.hello();
    socket.receive(snapshot());
    await read(reader);
    socket.receive({ ...snapshot(), topic: pool() });
    const status = await read(reader);
    assert.equal(status.event, "status");
    assert.deepEqual(status.data, { state: "recovering" });
    assert.equal(socket.closed, 1);
    await reader.cancel();
  }
  // Losing the upstream is not lost continuity: the relay resumes from its cursor
  // and the browser stays (stream-resume.test.ts and stream-feed.test.ts cover the rest).
  for (const lose of [
    (s: Socket) => s.receive(frame("resync_required", 11, { reason: "lagged" })),
    (s: Socket) => s.onclose?.({} as never),
  ]) {
    const sockets: Socket[] = [];
    const relay = new MarketStreamRelay(() => {
      sockets.push(new Socket());
      return sockets.at(-1)!;
    }, expected);
    const reader = open(relay, request()).body!.getReader();
    await read(reader);
    sockets[0]!.hello();
    sockets[0]!.receive(snapshot());
    await read(reader);
    lose(sockets[0]!);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(sockets.length, 2, "the relay reconnects upstream");
    sockets[1]!.hello();
    assert.ok(
      sockets[1]!.sent.some((op) => op.cursor === "10:1:1:0"),
      "and resumes the pool from its cursor",
    );
    await reader.cancel();
  }
});

test("topic, subscribe frame and downstream byte bounds refuse work and disconnect slow readers", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const readers = Array.from({ length: 32 }, (_, i) =>
    open(relay, request([pool(i * 2), pool(i * 2 + 1)])).body!.getReader(),
  );
  assert.equal(open(relay, request([pool(64)])).status, 503);
  socket.hello();
  const subscriptions = socket.sent.filter((value) => value.op === "subscribe");
  assert.ok(subscriptions.length > 1);
  assert.equal(subscriptions.flatMap((value) => value.topics).length, 65);
  for (const reader of readers) {
    await reader.cancel();
  }
  assert.equal(socket.closed, 1);

  const activeSocket = new Socket();
  const owner = new MarketStreamRelay(() => activeSocket, expected);
  const slow = open(owner, request()).body!.getReader();
  const healthy = open(owner, request()).body!.getReader();
  await read(healthy);
  activeSocket.hello();
  activeSocket.receive(snapshot());
  await read(healthy);
  for (let checkpoint = 11; checkpoint < 200; checkpoint++) {
    activeSocket.receive(trade(checkpoint));
    assert.equal((await read(healthy)).event, "market");
  }
  let queued = 0;
  for (;;) {
    const next = await slow.read();
    if (next.done) {
      break;
    }
    queued += next.value!.byteLength;
  }
  assert.ok(queued <= B.queueBytesPerClient, String(queued));
  assert.equal(activeSocket.closed, 0, "one slow browser does not stop healthy viewers");
  await healthy.cancel();
  assert.equal(activeSocket.closed, 1);
});

test("opted-in fleet counts market subscriptions and one engine socket per hints process", () => {
  const plan = fleetFixture();
  plan.hints.marketStream = true;
  plan.marketSubscribedTabs = 10_000;
  const env = {
    BLAST_BACKEND_FLEET_CONFIG: JSON.stringify(plan),
    BLAST_BACKEND_MARKET_STREAM_ENABLED: "true",
  };
  const local = {
    role: "hints",
    maxHintStreams: 512,
    maxInflight: 64,
  } as const;
  assert.throws(() => validateBackendFleet(env, local), /after one process failure/);
  plan.marketSubscribedTabs = 200;
  const result = validateBackendFleet(
    { ...env, BLAST_BACKEND_FLEET_CONFIG: JSON.stringify(plan) },
    local,
  )!;
  assert.equal(result.demand.infraHintSockets, plan.hints.replicas);
  delete plan.marketSubscribedTabs;
  assert.throws(
    () => validateBackendFleet({ ...env, BLAST_BACKEND_FLEET_CONFIG: JSON.stringify(plan) }, local),
    /bounded market/,
  );
});

test("shared browser fleet explicitly budgets unified tabs and legacy coexistence", () => {
  const plan = fleetFixture();
  plan.hints.marketStream = true;
  plan.hints.sharedBrowserStream = true;
  plan.marketSubscribedTabs = 10_000;
  const local = {
    role: "hints",
    maxHintStreams: 512,
    maxInflight: 64,
  } as const;
  const check = () =>
    validateBackendFleet(
      {
        BLAST_BACKEND_FLEET_CONFIG: JSON.stringify(plan),
        BLAST_BACKEND_MARKET_STREAM_ENABLED: "true",
      },
      local,
    );
  assert.throws(check, /explicit bounded legacy/);
  plan.legacyMarketStreams = 200;
  assert.equal(check()!.streamsAfterFailure, 10_240);
  plan.legacyMarketStreams = 241;
  assert.throws(check, /after one process failure/);
  plan.legacyMarketStreams = 10_001;
  assert.throws(check, /explicit bounded legacy/);
  plan.legacyMarketStreams = 200;
  plan.hints.sharedBrowserStream = false;
  assert.throws(check, /reserve requires shared/);
  delete plan.legacyMarketStreams;
  assert.throws(check, /after one process failure/);
  plan.hints.sharedBrowserStream = true;
  plan.hints.marketStream = false;
  plan.marketSubscribedTabs = 0;
  plan.legacyMarketStreams = 0;
  assert.throws(check, /settings differ/);
});

test("one shared stream combines sanitized activity hints with pool updates and supports hint-only clients", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, expected);
  const combined = open(relay, new Request(request().url + "&activity=true")).body!.getReader();
  await read(combined);
  socket.hello();
  const hello = (await read(combined)).data;
  assert.equal(hello.type, "hello");
  assert.equal(hello.heartbeat, true);
  assert.deepEqual(socket.sent[0], {
    op: "subscribe",
    topics: ["activity", `pool:${pool()}`],
  });
  socket.receive({ type: "pong" });
  assert.equal((await read(combined)).data.type, "pong");
  socket.receive(snapshot());
  assert.equal((await read(combined)).data.state, "live");
  socket.receive({
    type: "activity",
    activity_id: "committed-activity",
    ignored: "never-forward",
  });
  const hint = await read(combined);
  assert.equal(hint.event, "hint");
  assert.deepEqual(hint.data, {
    type: "activity",
    activity_id: "committed-activity",
  });
  socket.receive(trade());
  assert.equal((await read(combined)).event, "market");
  const hintOnly = open(
    relay,
    new Request(`https://frontend.test${MARKET_STREAM_PATH}?activity=true`),
  ).body!.getReader();
  await read(hintOnly);
  assert.equal((await read(hintOnly)).data.type, "hello");
  assert.equal((await read(hintOnly)).data.type, "pong");
  socket.receive({
    type: "presale_lifecycle",
    presale_id: "0x" + "a".repeat(64),
    state: "funded",
    private: "omit",
  });
  assert.equal((await read(hintOnly)).data.type, "presale_lifecycle");
  assert.equal((await read(combined)).data.type, "presale_lifecycle");
  await combined.cancel();
  assert.equal(socket.closed, 0, "hint-only client retains the common upstream");
  await hintOnly.cancel();
  assert.equal(socket.closed, 1);
  assert.deepEqual(
    marketStreamPools(new Request(`https://frontend.test${MARKET_STREAM_PATH}?activity=true`)),
    [],
  );
  for (const query of [
    "activity=false",
    "activity=true&activity=true",
    "activity=true&pool=feed",
  ]) {
    assert.throws(() =>
      marketStreamPools(new Request(`https://frontend.test${MARKET_STREAM_PATH}?${query}`)),
    );
  }
});
