import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_BACKOFF_MS,
  LIVE_OFF_MS,
  LIVE_PROTOCOL,
  LIVE_SPARE_TICKET_MS,
  fetchLiveTicket,
  liveMarketSource,
  liveSourceState,
  type LiveGrant,
  type LiveSocketLike,
} from "./live-socket-source.ts";

const PATH = "/api/launchpad/market/stream?activity=true&pool=p";
const GRANT: LiveGrant = { url: "wss://live.blast.test/v1/socket", ticket: "t" };

function harness(tickets: () => Promise<LiveGrant | null>, throwOnOpen = false, random = () => 0.5) {
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
    random,
  };
  const state = liveSourceState();
  const open = (path = PATH) => {
    const events: [string, string | undefined][] = [];
    const source = liveMarketSource(path, state, deps);
    for (const type of ["status", "market", "prices", "error", "refused"]) source.addEventListener(type, ({ data }) => events.push([type, data]));
    return { source, events };
  };
  return { open, sockets, timers, state, advance: (ms: number) => { now += ms; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// This fails if a screen joining a page while its ticket is on the way costs a second ticket, or if a
// ticket the caller gave up on, or one too old to still be valid, is ever used.
test("a ticket on its way when its source closes opens the tab's next source, not a second ticket", async () => {
  const asks: ((grant: LiveGrant) => void)[] = [];
  const { open, sockets, advance } = harness(() => new Promise((resolve) => asks.push(resolve)));
  open().source.close();
  open("/api/launchpad/market/stream?activity=true&pool=p&pool=q");
  asks[0]!(GRANT);
  await settle();
  assert.equal(asks.length, 1, "the page's second source asked for no ticket of its own");
  assert.deepEqual(sockets.map(({ url }) => url), [`${GRANT.url}?activity=true&pool=p&pool=q`], "one socket, with the pools wanted when it opened");

  open().source.close(true);
  open();
  assert.equal(asks.length, 3, "a ticket given up on (a deadline) serves no one");

  open().source.close();
  advance(LIVE_SPARE_TICKET_MS);
  open();
  assert.equal(asks.length, 5, "a spare ticket asked for too long ago is not used");
});

// This fails if a ticket ask that failed after its source closed is handed on, so the next source
// counts a failure or waits the off window without asking.
test("an ask that brings no ticket after its source closes serves no one", async () => {
  const asks: ((grant: LiveGrant | null) => void)[] = [];
  const fails: (() => void)[] = [];
  const { open, state } = harness(() => new Promise((resolve, reject) => {
    asks.push(resolve);
    fails.push(() => reject(new Error("ticket 503")));
  }));
  open().source.close();
  fails[0]!();
  await settle();
  open().source.close();
  asks[1]!(null);
  await settle();
  open();
  assert.equal(asks.length, 3, "each source after a failed or empty ask asks afresh");
  assert.equal(state.failures, 0);
  assert.equal(state.offUntil, 0);
});

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
  // The harness's random is 0.5: long waits are stretched by a quarter.
  const OFF = LIVE_OFF_MS * 1.25;
  const BACKOFF = LIVE_BACKOFF_MS * 1.25;

  let asked = 0;
  const off = harness(async () => { asked++; return null; });
  const first = off.open();
  await settle();
  assert.deepEqual(refusedWith(first.events), [OFF], "a 204 waits the off window");
  off.advance(1_000);
  const again = off.open();
  await settle();
  assert.deepEqual(refusedWith(again.events), [OFF - 1_000]);
  off.advance(OFF - 1_000);
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
  assert.deepEqual(refusedWith(afterRefusal.events), [BACKOFF - 1_000]);

  const failing = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    failing.open();
    await settle();
    failing.sockets.at(-1)!.onclose!({ code: 1006 });
  }
  const afterFailures = failing.open();
  await settle();
  assert.equal(failing.sockets.length, 3);
  assert.deepEqual(refusedWith(afterFailures.events), [BACKOFF], "three sockets closed before a frame");
  failing.advance(BACKOFF);
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
    source.close(true);
    hung.sockets.at(-1)!.onclose?.({ code: 1006 });
  }
  hung.open();
  await settle();
  assert.equal(hung.sockets.length, 3, "three silent sockets closed by the hub");

  // A pool change or a handover closes a socket before it spoke: that is not the network failing.
  const handover = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    handover.open().source.close();
    await settle();
  }
  assert.equal(handover.state.failures, 0, "closes without a deadline do not count");

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
  // `connecting` arrives before the upstream answers: a relay with its upstream down still backs off.
  const connecting = harness(async () => GRANT);
  for (let i = 0; i < 3; i++) {
    connecting.open();
    await settle();
    connecting.sockets.at(-1)!.onmessage!({ data: 'event: status\ndata: {"state":"connecting"}\n\n' });
    connecting.sockets.at(-1)!.onclose!({ code: 1006 });
  }
  connecting.open();
  await settle();
  assert.equal(connecting.sockets.length, 3, "connecting alone does not prove the stream");

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

// This fails if tabs that failed together come back together (one stampede every 10 or 30 minutes).
test("two tabs refused at the same moment wait different times", async () => {
  const waits: number[] = [];
  for (const random of [() => 0.1, () => 0.9]) {
    const tab = harness(async () => null, false, random);
    const { events } = tab.open();
    await settle();
    waits.push(Number(events.find(([type]) => type === "refused")![1]));
  }
  assert.notEqual(waits[0], waits[1]);
  for (const wait of waits) assert.ok(wait >= LIVE_OFF_MS && wait <= LIVE_OFF_MS * 1.5, String(wait));
});

// This fails if a ticket request that never answers holds the tab forever instead of counting as a failure.
test("a ticket that does not answer in time is a failure toward the backoff", async (t) => {
  t.mock.method(globalThis, "fetch", (_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  }));
  await assert.rejects(fetchLiveTicket(5), { name: "TimeoutError" });
  // A timeout is a throw, which the source counts.
  const throwing = harness(async () => { throw new DOMException("timed out", "TimeoutError"); });
  for (let i = 0; i < 3; i++) {
    const { events } = throwing.open();
    await settle();
    assert.deepEqual(events, [["error", undefined]]);
  }
  const { events } = throwing.open();
  await settle();
  assert.deepEqual(events.map(([type]) => type), ["refused"], "three timeouts back off");
});

// This fails if the caller's hello deadline, firing while the ticket request still hangs, is not counted.
test("a caller's deadline during a hung ticket request is a failure toward the backoff", async () => {
  const hung = harness(() => new Promise<never>(() => {}));
  for (let i = 0; i < 3; i++) {
    const { source } = hung.open();
    await settle();
    source.close(true);
  }
  const { events } = hung.open();
  await settle();
  assert.deepEqual(events.map(([type]) => type), ["refused"], "three hung tickets back off");
  // A close the caller chose (a pool change) is not a failure.
  const changed = harness(() => new Promise<never>(() => {}));
  for (let i = 0; i < 3; i++) {
    changed.open().source.close();
    await settle();
  }
  assert.equal(changed.state.failures, 0);
});
