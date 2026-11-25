import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_BACKOFF_MS,
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
  const timers: { run: () => void; ms: number }[] = [];
  const deps = {
    fetchTicket: tickets,
    openSocket: (url: string, protocols: string[]) => {
      if (throwOnOpen) throw new SyntaxError("bad protocol");
      const socket = { url, protocols, closed: false, onmessage: null, onclose: null, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
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
    for (const type of ["status", "market", "prices", "error", "refused"]) source.addEventListener(type, ({ data }) => events.push([type, data]));
    return { source, events };
  };
  return { open, sockets, timers, state, advance: (ms: number) => { now += ms; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// This fails if the socket's SSE blocks reach the hub differently from the
// SSE format, or if a healthy socket ever signals an error (which drops prices).
test("a healthy socket delivers its events and only a close reports an error", async () => {
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

// This fails if a browser keeps asking for tickets while the socket is off,
// refused for its address, or failing, or if the tab is not told how long to wait.
test("the tab gets refused, with the wait, while the socket is off, refused, or failing", async () => {
  const refusedWith = (events: [string, string | undefined][]) => events.filter(([type]) => type === "refused").map(([, data]) => Number(data));

  let asked = 0;
  const off = harness(async () => { asked++; return null; });
  const first = off.open();
  await settle();
  assert.deepEqual(refusedWith(first.events), [LIVE_OFF_MS], "a 204 waits the off window");
  off.advance(1_000);
  const again = off.open();
  await settle();
  assert.deepEqual(refusedWith(again.events), [LIVE_OFF_MS - 1_000]);
  off.advance(LIVE_OFF_MS - 1_000);
  assert.equal(asked, 1, "no ticket is asked for during the window");
  off.open();
  await settle();
  assert.equal(asked, 2, "the ticket is asked for again after the window");

  const refused = harness(async () => GRANT);
  refused.open();
  await settle();
  // Through Render's edge the code arrives in the last frame; the close itself says 1005.
  refused.sockets[0]!.onmessage!({ data: 'event: close\ndata: {"code":4429}\n\n' });
  refused.sockets[0]!.onclose!({ code: 1005 });
  refused.advance(1_000);
  const afterRefusal = refused.open();
  await settle();
  assert.equal(refused.sockets.length, 1, "a per-address refusal backs off at once");
  assert.deepEqual(refusedWith(afterRefusal.events), [LIVE_BACKOFF_MS - 1_000]);

  const failing = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    failing.open();
    await settle();
    failing.sockets.at(-1)!.onclose!({ code: 1006 });
  }
  const afterFailures = failing.open();
  await settle();
  assert.equal(failing.sockets.length, 3);
  assert.deepEqual(refusedWith(afterFailures.events), [LIVE_BACKOFF_MS], "three sockets closed before a frame");
  failing.advance(LIVE_BACKOFF_MS);
  failing.open();
  await settle();
  assert.equal(failing.sockets.length, 4, "the socket is tried again after the backoff");

  // A named refusal is no first frame: three framed 4401s still back off, and the frame never reaches listeners.
  const named = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    const { events } = named.open();
    await settle();
    named.sockets.at(-1)!.onmessage!({ data: 'event: close\ndata: {"code":4401}\n\n' });
    named.sockets.at(-1)!.onclose!({ code: 1005 });
    assert.deepEqual(events, [["error", undefined]]);
  }
  named.open();
  await settle();
  assert.equal(named.sockets.length, 3, "three named refusals before a frame");

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
  assert.equal(hung.sockets.length, 3, "three silent sockets closed by the hub");

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
  assert.equal(pongs.sockets.length, 3, "pongs alone do not prove the stream");

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
  sockets[0]!.onmessage!({ data: 'event: close\ndata: {"code":1012}\n\n' });
  sockets[0]!.onclose!({ code: 1005 });
  open();
  await settle();
  assert.equal(asked, 1);
  assert.deepEqual(timers.map(({ ms }) => ms), [5_000]);
  timers[0]!.run();
  await settle();
  assert.equal(asked, 2);
});
