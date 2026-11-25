import assert from "node:assert/strict";
import test from "node:test";

import type { MarketEventSource } from "#web/components/launchpad/market-stream-hub.ts";
import {
  LIVE_FALLBACK_MS,
  LIVE_OFF_MS,
  LIVE_PROTOCOL,
  liveMarketSource,
  liveSourceState,
  type LiveGrant,
  type LiveSocketLike,
} from "./live-socket-source.ts";

const PATH = "/api/launchpad/market/stream?activity=true&pool=p";
const GRANT: LiveGrant = { url: "wss://live.blast.test/v1/socket", ticket: "t" };

function harness(tickets: () => Promise<LiveGrant | null>, throwOnOpen = false) {
  let now = 1_000;
  const sockets: (LiveSocketLike & { url: string; protocols: string[]; closed: boolean })[] = [];
  const relays: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const deps = {
    fetchTicket: tickets,
    openSocket: (url: string, protocols: string[]) => {
      if (throwOnOpen) throw new SyntaxError("bad protocol");
      const socket = { url, protocols, closed: false, onmessage: null, onclose: null, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    openEventSource: (path: string): MarketEventSource => {
      relays.push(path);
      return { addEventListener() {}, close() {} };
    },
    schedule: (run: () => void, ms: number) => {
      timers.push({ run, ms });
      return () => {};
    },
    now: () => now,
    random: () => 0.5,
  };
  const state = liveSourceState();
  const open = () => {
    const events: [string, string | undefined][] = [];
    const source = liveMarketSource(PATH, state, deps);
    for (const type of ["status", "market", "prices", "error"]) source.addEventListener(type, ({ data }) => events.push([type, data]));
    return { source, events };
  };
  return { open, sockets, relays, timers, state, advance: (ms: number) => { now += ms; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// This fails if the socket's SSE blocks reach the hub differently from the
// relay's, or if a healthy socket ever signals an error (which drops prices).
test("a healthy socket delivers the relay's events and only a close reports an error", async () => {
  const { open, sockets, state } = harness(async () => GRANT);
  const { events } = open();
  await settle();
  assert.equal(sockets[0]!.url, `${GRANT.url}?activity=true&pool=p`);
  assert.deepEqual(sockets[0]!.protocols, [LIVE_PROTOCOL, "blast-ticket.t"]);
  sockets[0]!.onmessage!({ data: 'event: status\ndata: {"state":"live"}\n\n' });
  sockets[0]!.onmessage!({ data: 'event: market\nid: 12:0:0:0\ndata: {"a":1}\n\n: comment\n\nevent: prices\ndata: {"p":2}\n\n' });
  assert.deepEqual(events, [["status", '{"state":"live"}'], ["market", '{"a":1}'], ["prices", '{"p":2}']]);
  sockets[0]!.onclose!({ code: 1000 });
  assert.deepEqual(events.at(-1), ["error", undefined]);
  assert.equal(state.failures, 0, "a socket that delivered is not a failure");
});

// This fails if a browser keeps retrying a socket that is off, refused for its
// address, or failing, instead of using the SSE relay.
test("the tab uses the SSE relay while the socket is off, refused, or failing", async () => {
  const off = harness(async () => null);
  off.open();
  await settle();
  assert.deepEqual(off.relays, [PATH]);
  assert.equal(off.state.fallbackUntil, 1_000 + LIVE_OFF_MS);

  const refused = harness(async () => GRANT);
  refused.open();
  await settle();
  refused.sockets[0]!.onclose!({ code: 4429 });
  refused.open();
  await settle();
  assert.deepEqual(refused.relays, [PATH], "a per-address refusal falls back at once");
  assert.equal(refused.state.fallbackUntil, 1_000 + LIVE_FALLBACK_MS);

  const failing = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    failing.open();
    await settle();
    failing.sockets.at(-1)!.onclose!({ code: 1006 });
  }
  failing.open();
  await settle();
  assert.equal(failing.sockets.length, 3);
  assert.deepEqual(failing.relays, [PATH], "three sockets closed before a frame");
  failing.advance(LIVE_FALLBACK_MS);
  failing.open();
  await settle();
  assert.equal(failing.sockets.length, 4, "the socket is tried again after the fallback window");

  // A hung network: the hub's hello deadline closes sockets that never spoke.
  const hung = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    const { source } = hung.open();
    await settle();
    source.close();
    hung.sockets.at(-1)!.onclose?.({ code: 1006 });
  }
  hung.open();
  await settle();
  assert.deepEqual(hung.relays, [PATH], "three silent sockets closed by the hub");

  // A pong answers the tab's own clock ping: a socket that only ever pongs is still silent.
  const pongs = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    pongs.open();
    await settle();
    pongs.sockets.at(-1)!.onmessage!({ data: 'event: pong\ndata: {"t":1,"server_ms":2}\n\n' });
    pongs.sockets.at(-1)!.onclose!({ code: 1006 });
  }
  pongs.open();
  await settle();
  assert.deepEqual(pongs.relays, [PATH], "pongs alone do not prove the stream");

  const throwing = harness(async () => GRANT, true);
  const { events } = throwing.open();
  await settle();
  assert.deepEqual(events, [["error", undefined]], "a socket that cannot be built is an error, not silence");
  assert.equal(throwing.state.failures, 1);
});

// This fails if drained or full processes get every tab back at once.
test("after a drain close the next ticket waits a random 1–9 s", async () => {
  let asked = 0;
  const { open, sockets, timers } = harness(async () => { asked++; return GRANT; });
  open();
  await settle();
  sockets[0]!.onmessage!({ data: "event: status\ndata: {}\n\n" });
  sockets[0]!.onclose!({ code: 1012 });
  open();
  await settle();
  assert.equal(asked, 1);
  assert.deepEqual(timers.map(({ ms }) => ms), [5_000]);
  timers[0]!.run();
  await settle();
  assert.equal(asked, 2);
});
