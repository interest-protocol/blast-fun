import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys } from "#web/lib/query/keys.ts";
import { infraProvenanceFixture } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { hintInvalidation } from "../live-queries.ts";
import { ActivityHints, activityHints, HINT_GAP_MS, recordHintPainted, tabActivityHints, type HintSocket } from "./activity-hints.ts";
import type { FreshnessHint } from "./feed-freshness.ts";

const HELLO = { type: "hello", provenance: infraProvenanceFixture() };
const SALE = `0x${"a1".repeat(32)}`;
const activity = (id: string) => ({ type: "activity", activity_id: id });

class Socket implements HintSocket {
  closed = false;
  onmessage: HintSocket["onmessage"] = null;
  onclose: HintSocket["onclose"] = null;
  send(): void { /* The fake server below confirms the handshake. */ }
  close(): void { this.closed = true; }
  receive(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

function world(initiallyVisible = true, metric: () => void = () => undefined) {
  let visible = initiallyVisible;
  let now = 0;
  let next = 0;
  const sockets: Socket[] = [];
  const visibility = new Set<() => void>();
  const timers = new Map<number, () => void>();
  const delays = new Map<number, number>();
  const cancelled: (() => void)[] = [];
  const looks: FreshnessHint[] = [];
  const clock = {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = ++next;
      delays.set(id, ms);
      timers.set(id, () => { timers.delete(id); delays.delete(id); run(); });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      const run = timers.get(handle as number);
      if (run) cancelled.push(run);
      timers.delete(handle as number);
      delays.delete(handle as number);
    },
  };
  const hints = new ActivityHints({
    url: "/api/social/activity/hints", createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    ...clock, random: () => 0.5, visible: () => visible,
    onVisibilityChange: (listener) => { visibility.add(listener); return () => visibility.delete(listener); },
    metric,
  });
  return {
    hints, sockets, visibility, timers, delays, cancelled, looks, clock,
    subscribe: (name = "happening") => hints.subscribe(name, (hint) => { if (hint) looks.push(hint); }),
    show(value: boolean) { visible = value; for (const listener of visibility) listener(); },
    live() { const socket = sockets.at(-1)!; socket.receive(HELLO); socket.receive({ type: "pong" }); return socket; },
    advance(ms: number) { now += ms; },
  };
}

test("hidden subscriptions own no connection or retry; resume shares one handshake and catches up", () => {
  const w = world(false);
  const first = w.subscribe("feed_new");
  const second = w.subscribe("happening");
  assert.equal(w.sockets.length, 0);
  assert.equal(w.visibility.size, 1);
  assert.equal(w.hints.active(), false);
  w.show(true);
  w.show(true);
  assert.equal(w.sockets.length, 1);
  const socket = w.live();
  assert.equal(w.looks.length, 2);
  assert.ok(w.looks.every((hint) => hint.cause === "connect"));
  socket.receive(activity("seen"));
  assert.equal(w.timers.size, 2);
  w.show(false);
  assert.equal(socket.closed, true);
  assert.equal(w.hints.connected(), false);
  assert.equal(w.hints.active(), false);
  assert.equal(w.timers.size, 0);
  w.show(true);
  const resumed = w.live();
  assert.equal(w.sockets.length, 2);
  assert.equal(w.looks.length, 4, "each preserved subscription catches up without a later event");
  resumed.receive(activity("seen"));
  assert.equal(w.timers.size, 0, "visibility suspension preserves repeat suppression");
  first();
  assert.equal(resumed.closed, false);
  second();
  second();
  assert.equal(resumed.closed, true);
  assert.equal(w.visibility.size, 0);
  assert.equal(w.timers.size, 0);
});

test("cancelled reconnect and coalescer callbacks cannot mutate a resumed connection", () => {
  const w = world();
  const off = w.subscribe();
  const original = w.live();
  original.receive(activity("old"));
  const staleCoalescer = [...w.timers.values()][0]!;
  w.show(false);
  w.show(true);
  const resumed = w.live();
  resumed.receive(activity("new"));
  const current = [...w.timers.values()][0]!;
  const looks = w.looks.length;
  staleCoalescer();
  assert.equal(w.looks.length, looks);
  assert.equal(w.timers.size, 1, "old callback cannot clear the resumed coalescer");
  current();
  assert.equal(w.looks.at(-1)?.cause, "hint");
  resumed.onclose?.();
  const staleReconnect = [...w.timers.values()].at(-1)!;
  w.show(false);
  staleReconnect();
  assert.equal(w.hints.active(), false);
  w.show(true);
  const newest = w.live();
  newest.onclose?.();
  const count = w.sockets.length;
  staleReconnect();
  assert.equal(w.sockets.length, count, "old retry cannot bypass a newer reconnect delay");
  off();
  assert.equal(w.timers.size, 0);
});

test("refusal survives visibility transitions and the last unsubscribe owns cleanup", () => {
  const w = world();
  const off = w.subscribe();
  const socket = w.sockets[0]!;
  socket.receive({ type: "hello", provenance: {} });
  assert.equal(socket.closed, true);
  w.show(false);
  w.show(true);
  assert.equal(w.sockets.length, 1);
  assert.equal(w.hints.active(), false);
  off();
  w.show(false);
  w.show(true);
  assert.equal(w.visibility.size, 0);
  assert.equal(w.timers.size, 0);
  const again = w.subscribe();
  assert.equal(w.sockets.length, 2, "a new subscription may try after refusal, as before");
  again();
});

test("observation clocks, frame schedulers and sinks cannot break connection or refresh work", (t) => {
  const fail = () => { throw new Error("observation unavailable"); };
  const w = world(true, fail);
  const off = w.subscribe();
  assert.doesNotThrow(() => w.live());
  assert.equal(w.hints.connected(), true);
  const hint: FreshnessHint = { atMs: 0, cause: "hint" };
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousFrame) Object.defineProperty(globalThis, "requestAnimationFrame", previousFrame); else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: fail });
  assert.doesNotThrow(() => recordHintPainted("happening", hint));
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (run: FrameRequestCallback) => { run(0); return 1; } });
  const clock = t.mock.method(Date, "now", fail);
  assert.doesNotThrow(() => recordHintPainted("happening", hint));
  clock.mock.restore();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { va: fail } });
  t.mock.method(Math, "random", () => 0);
  assert.doesNotThrow(() => recordHintPainted("happening", hint));
  off();
});

test("resume invalidates missed lifecycle queries even without a new event", async () => {
  const w = world();
  const client = new QueryClient();
  const keys = [queryKeys.me.wallet(), queryKeys.me.portfolio(), queryKeys.me.presales(), queryKeys.me.presaleViewerAll, queryKeys.presales.detail(SALE)];
  for (const key of keys) client.setQueryData(key, { state: "before" });
  const off = hintInvalidation(client, activityHints("queries", w.hints), w.clock, () => 0);
  w.live();
  for (const key of keys) client.setQueryData(key, { state: "before" });
  w.show(false);
  w.advance(HINT_GAP_MS * 6);
  w.show(true);
  w.live();
  await Promise.resolve();
  for (const key of keys) assert.equal(client.getQueryState(key)?.isInvalidated, true, JSON.stringify(key));
  off();
  client.clear();
});

test("resume replaces an in-flight lifecycle read; another resume keeps the five-second gate", async () => {
  const w = world();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = queryKeys.me.wallet();
  const old = Promise.withResolvers<string>();
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => { reads += 1; return reads === 2 ? old.promise : `phase-${reads}`; },
  });
  const stop = observer.subscribe(() => undefined);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  const off = hintInvalidation(client, activityHints("queries", w.hints), w.clock, () => 0);
  try {
    w.live();
    const oldRefresh = client.invalidateQueries({ queryKey: key });
    await settle();
    assert.equal(reads, 2);
    w.show(false);
    w.show(true);
    w.live();
    await settle();
    assert.equal(reads, 3);
    assert.equal(client.getQueryData(key), "phase-3");
    old.resolve("old-open-phase");
    await oldRefresh;
    await settle();
    assert.equal(client.getQueryData(key), "phase-3", "an older phase cannot roll back visible recovery");
    w.show(false);
    w.show(true);
    w.live();
    await settle();
    assert.equal(reads, 3, "another catch-up respects the existing lifecycle floor");
    const kept = [...w.delays].find(([, ms]) => ms === 5_000)?.[0];
    assert.notEqual(kept, undefined);
    w.advance(5_000);
    w.timers.get(kept!)!();
    await settle();
    assert.equal(reads, 4, "the retained catch-up refreshes when the existing gate opens");
    assert.equal(client.getQueryData(key), "phase-4");
  } finally {
    old.resolve("old-open-phase");
    off();
    stop();
    client.clear();
  }
});

test("the browser factory closes EventSource while hidden and removes visibility ownership", async () => {
  const previous = Object.fromEntries(["window", "document", "EventSource"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  const sources: { closed: boolean; onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null }[] = [];
  class EventSource {
    closed = false;
    onmessage = null;
    onerror = null;
    constructor() { sources.push(this); }
    close() { this.closed = true; }
  }
  try {
    Object.defineProperty(globalThis, "document", { value: document, configurable: true });
    Object.defineProperty(globalThis, "window", { value: { setTimeout, clearTimeout }, configurable: true });
    Object.defineProperty(globalThis, "EventSource", { value: EventSource, configurable: true });
    const hints = tabActivityHints()!;
    const off = hints.subscribe("happening", () => undefined);
    assert.equal(sources.length, 0);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve(); // with no market stream starting, the legacy stream opens after the current task
    assert.equal(sources.length, 1);
    sources[0]!.onmessage?.({ data: JSON.stringify(HELLO) });
    sources[0]!.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(sources[0]!.closed, true);
    assert.equal(hints.active(), false);
    off();
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    assert.equal(sources.length, 1);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
