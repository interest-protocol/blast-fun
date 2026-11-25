import assert from "node:assert/strict";
import test from "node:test";
import { MarketStreamRelay } from "./stream-relay.ts";
import type { RelaySocket } from "../social/activity/hint-relay.ts";

const fingerprint = "a".repeat(64);
const provenance = { network: "mainnet", deployment_fingerprint: fingerprint, checkpoint: 10, timestamp_ms: 10000, observed_ms: 10000, lag_ms: 0 };
class Socket implements RelaySocket {
  sent: Record<string, unknown>[] = [];
  closed = 0;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed++; }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as Parameters<NonNullable<RelaySocket["onmessage"]>>[0]);
  }
}
async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = await reader.read();
  assert.equal(next.done, false);
  const text = new TextDecoder().decode(next.value);
  return { event: text.match(/^event: (.+)$/m)?.[1], data: JSON.parse(text.match(/^data: (.+)$/m)![1]!) };
}

test("the relay sends a four-second heartbeat only after a pong and times out from the ping", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, { network: "mainnet", deployment: fingerprint });
  const frames: string[] = [];
  relay.subscribe(new Request("https://frontend.test/api/launchpad/market/stream?activity=true"), {
    send: (chunk) => { frames.push(new TextDecoder().decode(chunk)); return true; },
    close: () => {},
  });

  t.mock.timers.tick(3_999);
  socket.receive({ type: "hello", protocol: 1, provenance });
  assert.match(frames.at(-1)!, /"heartbeat_ms":4000/);
  const sentAfterHello = socket.sent.length;
  t.mock.timers.tick(1);
  assert.equal(socket.closed, 0, "the first interval tick cannot expire a new ping");
  assert.equal(socket.sent.length, sentAfterHello, "one ping can be in flight");

  t.mock.timers.tick(5_999);
  socket.receive({ type: "pong" });
  assert.match(frames.at(-1)!, /"type":"pong"/);
  t.mock.timers.tick(4_000);
  socket.receive({ type: "pong" });
  const sentAfterHandshake = socket.sent.length;
  const confirmedFrames = frames.length;
  t.mock.timers.tick(2_001);
  assert.deepEqual(socket.sent.slice(sentAfterHandshake), [{ op: "ping" }]);
  assert.equal(frames.length, confirmedFrames, "an unanswered ping cannot refresh the browser watchdog");
  socket.receive({ type: "pong" });
  assert.equal(frames.at(-1), "event: heartbeat\ndata: {}\n\n");

  t.mock.timers.tick(4_000);
  const framesAtLoss = frames.length;
  const sentAtLoss = socket.sent.length;
  t.mock.timers.tick(7_999);
  assert.equal(socket.closed, 0);
  assert.equal(socket.sent.length, sentAtLoss, "later ticks neither repeat the ping nor extend its deadline");
  assert.equal(frames.length, framesAtLoss);
  t.mock.timers.tick(1);
  assert.equal(socket.closed, 1);
  assert.equal(frames.length, framesAtLoss, "browsers stay connected and quiet while the relay reconnects");
});

test("optional feed refusal preserves activity and sanitizes metadata on the combined stream", async () => {
  const socket = new Socket();
  const relay = new MarketStreamRelay(() => socket, { network: "mainnet", deployment: fingerprint });
  const reader = relay.stream(new Request("https://frontend.test/api/launchpad/market/stream?activity=true")).body!.getReader();
  try {
    await read(reader);
    socket.receive({ type: "hello", protocol: 1, provenance });
    await read(reader);
    socket.receive({ type: "pong" });
    await read(reader);
    assert.deepEqual(socket.sent.slice(-2), [{ op: "subscribe", topics: ["feed"] }, { op: "ping" }]);
    socket.receive({ type: "error", code: "topic_forbidden" });
    assert.equal(socket.closed, 0);
    socket.receive({ type: "activity", activity_id: "activity-1", private_payload: "stripped" });
    assert.deepEqual((await read(reader)).data, { type: "activity", activity_id: "activity-1" });
    const coin = `0x${"1".repeat(64)}::coin::COIN`;
    socket.receive({ type: "metadata", coin, cursor: "10:1:1:0", private_payload: "stripped" });
    assert.deepEqual((await read(reader)).data, { type: "metadata", coin, cursor: "10:1:1:0" });
  } finally { await reader.cancel(); }
});

test("the relay reads subscribed prices in one batch and sends each client only its changed prices", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new Socket();
  const coin = (digit: string) => `0x${digit.repeat(64)}::coin::COIN`;
  const firstPrice = { coin_type: coin("1"), usd_price: "0.05", as_of_ms: 10_000 };
  const secondPrice = { coin_type: coin("2"), usd_price: "0.02", as_of_ms: 10_000 };
  const requests: string[][] = [];
  let prices = [firstPrice, secondPrice];
  const relay = new MarketStreamRelay(() => socket, { network: "mainnet", deployment: fingerprint },
    async (coins) => {
      requests.push([...coins]);
      return { checkpoint: 9 + requests.length, prices };
    },
  );
  const subscribe = (type: string) => relay.stream(new Request(
    `https://frontend.test/api/launchpad/market/stream?${new URLSearchParams({ activity: "true", price_coin: type })}`,
  )).body!.getReader();
  const first = subscribe(firstPrice.coin_type);
  const second = subscribe(secondPrice.coin_type);
  try {
    await read(first);
    await read(second);
    socket.receive({ type: "hello", protocol: 1, provenance });
    assert.equal((await read(first)).event, "hint");
    assert.equal((await read(second)).event, "hint");
    socket.receive({ type: "pong" });
    assert.equal((await read(first)).data.type, "pong");
    assert.equal((await read(second)).data.type, "pong");
    socket.receive({ type: "pong" });
    assert.equal((await read(first)).event, "heartbeat");
    assert.equal((await read(second)).event, "heartbeat");
    t.mock.timers.tick(1);
    assert.deepEqual(await read(first), { event: "prices", data: { checkpoint: 10, prices: [firstPrice] } });
    assert.deepEqual(await read(second), { event: "prices", data: { checkpoint: 10, prices: [secondPrice] } });
    assert.deepEqual(requests, [[firstPrice.coin_type, secondPrice.coin_type]]);

    const readPrices = (...next: typeof prices) => {
      prices = next;
      t.mock.timers.tick(2_001);
    };
    const corrected = { ...secondPrice, usd_price: "0.03" };
    readPrices(firstPrice, corrected);
    assert.deepEqual(await read(second), { event: "prices", data: { checkpoint: 11, prices: [corrected] } });

    const refreshed = { ...firstPrice, as_of_ms: 11_000 };
    readPrices(refreshed);
    assert.deepEqual(await read(first), { event: "prices", data: { checkpoint: 12, prices: [refreshed] } });

    const freshSecond = { ...secondPrice, usd_price: "0.04", as_of_ms: 11_000 };
    readPrices(firstPrice, freshSecond);
    assert.deepEqual(await read(second), { event: "prices", data: { checkpoint: 13, prices: [freshSecond] } });

    const freshFirst = { ...firstPrice, usd_price: "0.06", as_of_ms: 12_000 };
    readPrices(freshFirst);
    assert.deepEqual(await read(first), { event: "prices", data: { checkpoint: 14, prices: [freshFirst] } });
  } finally {
    await first.cancel();
    await second.cancel();
  }
});

for (const type of ["resync_required", "reconnect"]) {
  test(`${type} during optional feed handshake reconnects upstream and keeps the browser`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const sockets: Socket[] = [];
    const relay = new MarketStreamRelay(() => {
      sockets.push(new Socket());
      return sockets.at(-1)!;
    }, { network: "mainnet", deployment: fingerprint });
    const events: string[] = [];
    let closed = false;
    const stop = relay.subscribe(new Request("https://frontend.test/api/launchpad/market/stream?activity=true"), {
      send: (chunk) => { events.push(new TextDecoder().decode(chunk).match(/^event: (.+)$/m)![1]!); return true; },
      close: () => { closed = true; },
    }) as () => void;
    sockets[0]!.receive({ type: "hello", protocol: 1, provenance });
    sockets[0]!.receive({ type: "pong" });
    sockets[0]!.receive({ type });
    assert.equal(sockets[0]!.closed, 1);
    assert.equal(closed, false);
    assert.equal(events.includes("resync"), false);
    t.mock.timers.tick(400);
    assert.equal(sockets.length, 2);
    sockets[1]!.receive({ type: "hello", protocol: 1, provenance });
    assert.equal(events.at(-1), "hint", "the browser gets the new hello");
    stop();
  });
}
