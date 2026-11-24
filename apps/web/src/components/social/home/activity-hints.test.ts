import assert from "node:assert/strict";
import test, { afterEach, mock, type TestContext } from "node:test";
afterEach(() => mock.restoreAll());

import { infraProvenanceFixture } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";

import {
  ACTIVITY_HINTS_METRIC,
  ActivityHints,
  activityHints,
  HINT_GAP_MS,
  hintEventStream,
  liveFreshness,
  RECONNECT_CAP_MS,
  reconnectDelay,
  recordHintPainted,
  STABLE_MS,
  tabActivityHints,
  type ActivityHintsDependencies,
  type HintSocket,
} from "./activity-hints.ts";
import { anyFreshness, hintedGap, pollingFreshness, type FreshnessEnvironment, type FreshnessHint } from "./feed-freshness.ts";

/** R3-26: the blast-infra `activity` hint (T-035) as a freshness source, without a browser. */

/** A socket the test drives; it records what the client sends. */
class FakeSocket implements HintSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  unavailable?: boolean;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {
    this.closed = true;
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  /** The connection drops (the engine restarts, the network goes). */
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }
}

// The frames as blast-infra docs/api.md (sfd/T-035-1) gives them.
const HELLO = { type: "hello", engine_id: "aws-1", protocol: 1, cursor: "326274009:3:1:0", provenance: infraProvenanceFixture() };
const SALE = `0x${"a1".repeat(32)}`;
const ACTIVITY = {
  type: "activity",
  activity_id: "326274009:3:1:0",
  kind: "presale_commit",
  presale_id: SALE,
  coin_type: `0x${"b2".repeat(32)}::blast::BLAST`,
  timestamp_ms: 1_790_235_061_218,
};
const LIFECYCLE = { type: "presale_lifecycle", presale_id: SALE, state: "funded", timestamp_ms: 1_790_300_000_000 };

/** The client over fake sockets, clock, timers, visibility and metric sink. */
function world(options: Readonly<{ random?: () => number; refuseSocket?: boolean; metric?: ActivityHintsDependencies["metric"]; spreadMs?: number }> = {}) {
  let now = 1_000_000;
  let visible = true;
  let ids = 0;
  const sockets: FakeSocket[] = [];
  const timers: { at: number; run: () => void; id: number }[] = [];
  const metrics: Record<string, unknown>[] = [];
  const hints = new ActivityHints({
    url: "wss://infra.blast.test/v1/ws",
    createSocket: (url) => {
      if (options.refuseSocket) throw new Error("SecurityError");
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    setTimeout: (run, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    random: options.random ?? (() => 0.5),
    ...(options.spreadMs === undefined ? {} : { spreadMs: options.spreadMs }),
    visible: () => visible,
    metric: options.metric ?? ((name, fields) => metrics.push({ metric: name, ...fields })),
  });
  return {
    hints,
    sockets,
    timers,
    metrics,
    now: () => now,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = timers[0];
        if (!due || due.at > until) break;
        timers.shift();
        now = due.at;
        due.run();
      }
      now = until;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    socket: () => sockets[sockets.length - 1],
    openSockets: () => sockets.filter((socket) => !socket.closed).length,
    /** The newest socket says hello and confirms the subscribe. */
    live() {
      const socket = sockets[sockets.length - 1];
      socket.receive(HELLO);
      socket.receive({ type: "pong" });
    },
    events: (event: string) => metrics.filter((line) => line.event === event),
  };
}

/** A surface that records each look with the time it came. */
function surface(w: ReturnType<typeof world>, name = "happening") {
  const looks: { at: number; hint: FreshnessHint | undefined }[] = [];
  const off = w.hints.subscribe(name, (hint) => looks.push({ at: w.now(), hint }));
  return { looks, off };
}

test("SSR and browsers without EventSource keep polling; no private infra wiring reaches the browser", async () => {
  assert.equal(tabActivityHints(), null);
  assert.equal(liveFreshness("happening").name, "poll");
});

test("R3-26: one socket per tab, opened lazily by the first surface; subscribe after a mainnet hello, look once the pong confirms it", () => {
  const w = world();
  assert.equal(w.sockets.length, 0, "nothing until a surface wants freshness");
  const tape = surface(w, "happening");
  const pill = surface(w, "feed_new");
  assert.equal(w.sockets.length, 1, "two surfaces share one socket");
  assert.equal(w.socket().url, "wss://infra.blast.test/v1/ws");
  assert.deepEqual(w.socket().sent, [], "nothing is sent before hello");
  w.socket().receive(HELLO);
  assert.deepEqual(w.socket().sent, [{ op: "subscribe", topics: ["activity"] }, { op: "ping" }]);
  assert.deepEqual([tape.looks.length, pill.looks.length], [0, 0], "no look before the subscribe is confirmed");
  w.socket().receive({ type: "pong" });
  // No snapshot and no resume: a connect learns what it missed only by reading again.
  assert.deepEqual(tape.looks.map((look) => look.hint?.cause), ["connect"]);
  assert.deepEqual(pill.looks.map((look) => look.hint?.cause), ["connect"]);
  assert.deepEqual(w.events("connect").length, 1);
  // A later surface joins the open socket and reads on its own: no extra socket, no connect look for it.
  const late = surface(w, "ticker");
  assert.equal(w.sockets.length, 1);
  assert.equal(late.looks.length, 0);
});

test("R3-26-AC-2: a hint is a signal, not data: a frame with fabricated amounts gives a surface only when and why", () => {
  const w = world();
  const tape = surface(w);
  w.live();
  w.advance(HINT_GAP_MS);
  w.socket().receive({ ...ACTIVITY, amount: "999999999999", usd: "123456789.00", last_hour: { wallets: 999_999, usd: "1e12" } });
  const hint = tape.looks.at(-1)?.hint;
  assert.deepEqual(hint, { atMs: w.now(), cause: "hint" });
  assert.deepEqual(Object.keys(hint ?? {}).sort(), ["atMs", "cause"], "nothing of the message reaches a surface");
  assert.equal(Object.isFrozen(hint), true);
  // A frame of another shape is still only a signal: a shape change cannot break (or paint) a figure.
  w.advance(HINT_GAP_MS);
  w.socket().receive({ type: "activity" });
  assert.equal(tape.looks.at(-1)?.hint?.cause, "hint");
  // Non-JSON, arrays and unknown types are ignored.
  const before = tape.looks.length;
  w.advance(HINT_GAP_MS);
  w.socket().receive("{not json");
  w.socket().receive([ACTIVITY]);
  w.socket().receive({ type: "trade", trade: { quote_amount: "1" } });
  assert.equal(tape.looks.length, before);
});

test("R3-26: a repeated row hints once (activity_id; a lifecycle row's sale and state); resync_required is a look", () => {
  const w = world();
  const tape = surface(w);
  w.live();
  w.advance(HINT_GAP_MS);
  w.socket().receive(ACTIVITY);
  w.advance(HINT_GAP_MS);
  w.socket().receive(ACTIVITY);
  w.advance(HINT_GAP_MS);
  w.socket().receive(LIFECYCLE);
  w.advance(HINT_GAP_MS);
  w.socket().receive(LIFECYCLE);
  w.advance(HINT_GAP_MS);
  w.socket().receive({ ...LIFECYCLE, state: "migrated" });
  w.advance(HINT_GAP_MS);
  w.socket().receive({ type: "resync_required", reason: "lagged" });
  assert.deepEqual(tape.looks.map((look) => look.hint?.cause), ["connect", "hint", "hint", "hint", "resync"]);
  assert.deepEqual(w.events("hint").map((line) => line.kind), ["activity", "presale_lifecycle", "presale_lifecycle"]);
});

test("a browser tab spreads plain looks across tabs, but lifecycle and coin hints still look at once; hidden or departed surfaces never look", () => {
  const w = world({ spreadMs: 1_000, random: () => 0.25 });
  const tape = surface(w, "happening");
  const queries = surface(w, "queries");
  w.live();
  assert.equal(tape.looks.length, 0, "the connect look waits its share of the spread");
  w.advance(249);
  assert.equal(tape.looks.length, 0);
  w.advance(1);
  assert.deepEqual(tape.looks.map((look) => [look.at - 1_000_000, look.hint?.cause]), [[250, "connect"]]);
  w.advance(HINT_GAP_MS);
  w.socket().receive(ACTIVITY);
  assert.equal(tape.looks.length, 1, "a plain hint is spread too");
  w.advance(250);
  assert.deepEqual(tape.looks.map((look) => look.hint?.cause), ["connect", "hint"]);
  const before = queries.looks.length;
  w.advance(HINT_GAP_MS);
  w.socket().receive(LIFECYCLE);
  assert.equal(queries.looks.length, before + 1, "a phase change reaches the query cache at once");
  w.socket().receive({ type: "metadata", coin: `0x${"c3".repeat(32)}::coin::COIN`, cursor: "9:1:0:0" });
  assert.equal(tape.looks.at(-1)?.hint?.coinType, `0x${"c3".repeat(32)}::coin::COIN`, "a coin identity change reaches every surface at once");
  // A spread look is the surface's kept look: a tab hidden by then does not look, nor does a surface that left.
  w.advance(HINT_GAP_MS);
  const looks = tape.looks.length;
  w.socket().receive({ ...ACTIVITY, activity_id: "spread-hidden" });
  w.setVisible(false);
  w.advance(1_000);
  assert.equal(tape.looks.length, looks, "hidden when due");
  w.setVisible(true);
  w.advance(HINT_GAP_MS);
  w.socket().receive({ ...ACTIVITY, activity_id: "spread-left" });
  tape.off();
  w.advance(1_000);
  assert.equal(tape.looks.length, looks, "unsubscribed before due");
});

test("R3-26-AC-5: 50 hints in one second look at most once per surface per second, each surface on its own", () => {
  const w = world();
  const tape = surface(w, "happening");
  const pill = surface(w, "feed_new");
  w.live();
  w.advance(5_000);
  const start = w.now();
  for (let index = 0; index < 50; index += 1) {
    w.socket().receive({ ...ACTIVITY, activity_id: `326274010:${index}:0:0` });
    w.advance(20);
  }
  w.advance(5_000);
  for (const each of [tape, pill]) {
    const looks = each.looks.filter((look) => look.at >= start);
    // Leading edge at once, one trailing look at the end of the second for the rest.
    assert.deepEqual(looks.map((look) => look.at - start), [0, HINT_GAP_MS]);
    assert.deepEqual(looks.map((look) => look.hint?.cause), ["hint", "hint"]);
    // The trailing look carries the first hint it held back, so hint → paint counts from it.
    assert.equal(looks[1].hint?.atMs, start + 20);
  }
  assert.equal(w.events("hint").length, 50);
  assert.deepEqual(
    w.events("refetch").filter((line) => line.cause === "hint").map((line) => line.surface),
    ["happening", "feed_new", "happening", "feed_new"],
  );
  assert.equal(w.timers.length, 0, "nothing left waiting");
});

test("R3-26-AC-4: reconnect waits are full jitter under a ceiling that doubles from 1 s and stops at 30 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 30, 1_000].map((failures) => reconnectDelay(failures, () => 0)), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((failures) => reconnectDelay(failures, () => 0.5)), [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  const top = [0, 1, 2, 3, 4, 5, 6, 30, 1_000].map((failures) => reconnectDelay(failures, () => 0.999_999));
  assert.deepEqual(top, [999, 1_999, 3_999, 7_999, 15_999, 29_999, 29_999, 29_999, 29_999]);
  for (let failures = 0; failures < 64; failures += 1) {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999_999, 1]) assert.ok(reconnectDelay(failures, () => random) <= RECONNECT_CAP_MS);
  }
});

test("R3-26-AC-4: a dropped socket reconnects with growing jittered waits, looks again on every reconnect, and starts over once stable", () => {
  const w = world({ random: () => 0.999 });
  const tape = surface(w);
  w.live();
  const waits: number[] = [];
  for (let drop = 0; drop < 7; drop += 1) {
    w.socket().drop();
    assert.equal(w.timers.length, 1, "one reconnect waits");
    waits.push(w.timers[0].at - w.now());
    w.advance(waits.at(-1) ?? 0);
    assert.equal(w.sockets.length, drop + 2, "a new socket");
    w.live();
    w.advance(HINT_GAP_MS);
  }
  assert.deepEqual(waits, [999, 1_998, 3_996, 7_992, 15_984, 29_970, 29_970]);
  // Every (re)connect is a look: the topic has no resume.
  assert.equal(tape.looks.filter((look) => look.hint?.cause === "connect").length, 8);
  assert.deepEqual(w.events("connect").length, 1);
  assert.deepEqual(w.events("reconnect").map((line) => line.failures), [1, 2, 3, 4, 5, 6, 7]);
  // A socket live for STABLE_MS was healthy: the next drop waits under a second again.
  w.advance(STABLE_MS);
  w.socket().drop();
  assert.equal(w.timers[0].at - w.now(), 999);
  // A socket refused before hello (the origin is not allowed) keeps backing off, never faster.
  w.advance(999);
  w.socket().drop();
  assert.equal(w.timers[0].at - w.now(), 1_998);
});

test("R3-26: not mainnet, an engine without the topic, or a socket the browser refuses: closed for good, the poll carries on", (t) => {
  const testnet = world();
  const tape = surface(testnet);
  testnet.socket().receive({ ...HELLO, provenance: infraProvenanceFixture({ network: "testnet" }) });
  assert.equal(testnet.socket().closed, true);
  assert.deepEqual(testnet.socket().sent, [], "nothing subscribed on another network's engine");
  assert.equal(testnet.timers.length, 0, "and no reconnect");
  assert.deepEqual(testnet.events("unavailable").map((line) => line.reason), ["network"]);
  assert.equal(tape.looks.length, 0);
  assert.equal(testnet.hints.active(), false);

  const garbled = world();
  surface(garbled);
  garbled.socket().receive({ ...HELLO, provenance: null });
  assert.deepEqual(garbled.events("unavailable").map((line) => line.reason), ["hello"]);

  const old = world();
  const pill = surface(old, "feed_new");
  old.socket().receive(HELLO);
  old.socket().receive({ type: "error", error: { code: "invalid_parameter", message: "unknown topic" } });
  assert.equal(old.socket().closed, true);
  assert.equal(old.timers.length, 0);
  assert.deepEqual(old.events("unavailable").map((line) => line.reason), ["subscribe"]);
  assert.equal(pill.looks.length, 0);
  // When the surfaces start over (another page), it tries again.
  pill.off();
  surface(old);
  assert.equal(old.sockets.length, 2);

  const blocked = world({ refuseSocket: true });
  surface(blocked);
  assert.deepEqual(blocked.events("unavailable").map((line) => line.reason), ["socket"]);
  assert.equal(blocked.timers.length, 0);

  // With the socket closed the poll still looks every 30 s: anyFreshness keeps it.
  const fake = fakeEnvironment(t);
  const looks: (FreshnessHint | undefined)[] = [];
  const w = world();
  anyFreshness(activityHints("happening", w.hints), pollingFreshness(30_000)).subscribe((hint) => looks.push(hint));
  w.socket().receive({ ...HELLO, provenance: infraProvenanceFixture({ network: "devnet" }) });
  fake.tick();
  fake.tick();
  assert.deepEqual(looks, [undefined, undefined]);
});

test("R3-26-AC-6: a background tab does not look on hints; shown again, the source pair looks exactly once (the poll's)", (t) => {
  const w = world();
  const fake = fakeEnvironment(t);
  const looks: (FreshnessHint | undefined)[] = [];
  const off = anyFreshness(activityHints("happening", w.hints), pollingFreshness(30_000)).subscribe((hint) => looks.push(hint));
  w.live();
  assert.deepEqual(looks.map((hint) => hint?.cause), ["connect"]);
  w.advance(HINT_GAP_MS);
  w.setVisible(false);
  fake.setVisible(false);
  for (let index = 0; index < 10; index += 1) {
    w.socket().receive({ ...ACTIVITY, activity_id: `9:${index}:0:0` });
    w.advance(300);
  }
  w.socket().receive({ type: "resync_required", reason: "lagged" });
  w.advance(60_000);
  assert.equal(looks.length, 1, "nothing while hidden");
  assert.equal(w.timers.length, 0, "and no timer waits for it");
  assert.equal(w.events("hint").length, 10, "the hints were still heard");
  w.setVisible(true);
  fake.setVisible(true);
  w.advance(5_000);
  assert.deepEqual(looks, [looks[0], undefined], "one look on showing: the poll's");
  off();
});

test("R3-26-AC-7: the last surface leaving closes the socket; 20 mount/unmount cycles leave no socket and no timer", () => {
  const w = world();
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const tape = surface(w, "happening");
    const pill = surface(w, "feed_new");
    if (cycle % 3 !== 2) w.live();
    if (cycle % 3 === 0) {
      // A burst leaves a trailing look waiting.
      w.socket().receive({ ...ACTIVITY, activity_id: `${cycle}:0:0:0` });
      w.socket().receive({ ...ACTIVITY, activity_id: `${cycle}:1:0:0` });
    }
    if (cycle % 3 === 1) w.socket().drop(); // a reconnect waits
    tape.off();
    assert.equal(w.hints.active(), true, "the other surface still holds it");
    pill.off();
    pill.off(); // twice is harmless
    assert.equal(w.hints.active(), false);
    assert.equal(w.openSockets(), 0);
    assert.equal(w.timers.length, 0);
  }
  assert.equal(w.sockets.length, 20);
  // A closed socket's late frames and close are ignored.
  w.sockets[0].receive(ACTIVITY);
  w.sockets[0].drop();
  assert.equal(w.timers.length, 0);
});

test("R3-26-AC-8: fixed server metrics and sampled browser hint-to-refresh observations", async (t) => {
  const { recordMetric } = await import("@blast/core/lib/metrics.ts");
  const lines: Record<string, unknown>[] = [];
  const info = console.info;
  console.info = (line: string) => lines.push(JSON.parse(line));
  try {
    const w = world({ random: () => 0, metric: recordMetric });
    const tape = surface(w, "happening");
    w.live();
    w.advance(HINT_GAP_MS);
    w.socket().receive(ACTIVITY);
    w.advance(840);
    const events: unknown[] = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { va: (...args: unknown[]) => events.push(args) } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
    t.mock.method(Date, "now", w.now);
    t.mock.method(Math, "random", () => 0);
    recordHintPainted("happening", tape.looks.at(-1)?.hint);
    assert.deepEqual(events, [["event", { name: "social_hint_observation", data: { event: "refresh_completed", surface: "happening", ms: 840, freshness: "unverified", sampleRate: 0.02, capPerMinute: 20 }, options: undefined }]]);
    recordHintPainted("happening", { atMs: 0, cause: "connect" });
    recordHintPainted("happening", undefined);
    assert.equal(events.length, 1);
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
    w.advance(HINT_GAP_MS);
    w.socket().drop();
    w.advance(0);
    w.live();
  } finally {
    console.info = info;
  }
  const ours = lines.filter((line) => line.metric === ACTIVITY_HINTS_METRIC).map(({ at, metric, level, ...fields }) => {
    assert.equal(typeof at, "string");
    assert.equal(metric, "social.activity_hints");
    assert.equal(level, 30);
    return fields;
  });
  assert.deepEqual(ours, [
    { event: "connect" },
    { event: "refetch", surface: "happening", cause: "connect" },
    { event: "hint", kind: "activity" },
    { event: "refetch", surface: "happening", cause: "hint" },
    { event: "reconnect", failures: 1 },
    { event: "refetch", surface: "happening", cause: "connect" },
  ]);

});

test("R3-26: a reader's 5 s floor keeps a hint that lands inside it and reads once it passes; a poll signal there is dropped as before", () => {
  let now = 0;
  let ids = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  const retried: FreshnessHint[] = [];
  const gate = hintedGap(5_000, {
    now: () => now,
    setTimeout: (run, ms) => {
      timers.push({ at: now + ms, run, id: ++ids });
      return ids;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  }, (hint) => retried.push(hint));
  const run = () => {
    const due = timers.shift();
    now = due?.at ?? now;
    due?.run();
  };
  assert.equal(gate.admit(), true, "a read at 0");
  now = 1_000;
  assert.equal(gate.admit(), false);
  assert.equal(timers.length, 0, "the poll inside the floor: dropped, nothing waits (T-012 unchanged)");
  const first: FreshnessHint = { atMs: 1_500, cause: "hint" };
  now = 1_500;
  assert.equal(gate.admit(first), false);
  now = 2_000;
  assert.equal(gate.admit({ atMs: 2_000, cause: "hint" }), false);
  assert.deepEqual(timers.map((timer) => timer.at), [5_000], "one kept: the earliest, due when the floor passes");
  run();
  assert.deepEqual(retried, [first]);
  assert.equal(gate.admit(first), true, "the retry reads");
  // Any read drops a kept hint: the hinted row was committed before the read began.
  now = 6_000;
  assert.equal(gate.admit({ atMs: 6_000, cause: "connect" }), false);
  assert.equal(timers.length, 1);
  now = 10_000;
  assert.equal(gate.admit(), true, "the poll reads first");
  assert.equal(timers.length, 0);
  // Unsubscribing or starting over drops it too.
  now = 11_000;
  gate.admit({ atMs: 11_000, cause: "resync" });
  gate.cancel();
  assert.equal(timers.length, 0);
  gate.admit({ atMs: 11_000, cause: "hint" });
  gate.reset();
  assert.equal(timers.length, 0);
  assert.equal(gate.admit(), true, "reset forgets the last read");
  assert.deepEqual(retried, [first]);
});

/** The poll's fake browser, as feed-freshness.test.ts drives it. */
function fakeEnvironment(t: TestContext) {
  const intervals = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  let next = 0;
  let isVisible = true;
  const environment: FreshnessEnvironment = {
    visible: () => isVisible,
    onVisibilityChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setInterval(run) {
      next += 1;
      intervals.set(next, run);
      return next;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setInterval: environment.setInterval, clearInterval: environment.clearInterval } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    get visibilityState() { return isVisible ? "visible" : "hidden"; },
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
  } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  });
  return {
    environment,
    tick: () => [...intervals.values()].forEach((run) => run()),
    setVisible(value: boolean) {
      isVisible = value;
      for (const listener of listeners) listener();
    },
  };
}

test("the same-origin SSE adapter shares the tab connection and delegates reconnect to ActivityHints", () => {
  const previous = globalThis.EventSource;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const visibility = new EventTarget();
  let opened = 0;
  let closed = 0;
  const sources: { onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null }[] = [];
  class FakeEventSource {
    onmessage = null;
    onerror = null;
    constructor(url: string) {
      assert.equal(url, "/api/social/activity/hints");
      opened += 1;
      sources.push(this);
    }
    close() { closed += 1; }
  }
  try {
    Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", { value: Object.assign(visibility, { visibilityState: "visible" }), configurable: true, writable: true });
    const adapter = hintEventStream("/api/social/activity/hints");
    const frames: unknown[] = [];
    adapter.onmessage = (message) => frames.push(message.data);
    let disconnected = false;
    adapter.onclose = () => { disconnected = true; };
    sources[0].onmessage?.({ data: JSON.stringify(HELLO) });
    assert.deepEqual(frames, [JSON.stringify(HELLO)]);
    visibility.dispatchEvent(new Event("visibilitychange"));
    assert.equal(JSON.parse(String(frames[1])).type, "resync_required", "returning to a tab recovers missed hints");
    sources[0].onerror?.();
    assert.equal(disconnected, true);
    assert.equal(closed, 1, "native reconnect stops so the existing backoff owns reconnects");
    visibility.dispatchEvent(new Event("visibilitychange"));
    assert.equal(frames.length, 2, "the transport removes its visibility listener on close");
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    const shared = tabActivityHints();
    assert.ok(shared);
    assert.equal(tabActivityHints(), shared);
    assert.equal(opened, 1, "the tab's stream is lazy until a surface subscribes");
  } finally {
    Object.defineProperty(globalThis, "EventSource", { value: previous, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true, writable: true });
  }
});

test("connection status enables the fallback on loss; presales-only mainnet hello is valid", () => {
  const w = world();
  const statuses: boolean[] = [];
  const offStatus = w.hints.subscribeConnection(() => statuses.push(w.hints.connected()));
  const reader = surface(w);
  w.socket().receive({ ...HELLO, provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
  w.socket().receive({ type: "pong" });
  assert.equal(w.hints.connected(), true);
  w.socket().drop();
  assert.equal(w.hints.connected(), false);
  w.advance(500);
  w.live();
  reader.off();
  offStatus();
  assert.deepEqual(statuses, [true, false, true, false]);
});

test("a migration reaches query readers immediately even when an activity hint is coalesced", () => {
  const w = world();
  const queries = surface(w, "queries");
  w.live();
  w.socket().receive(ACTIVITY);
  w.socket().receive({ ...LIFECYCLE, state: "migrated" });
  assert.deepEqual(queries.looks.at(-1)?.hint, { atMs: w.now(), cause: "hint", presaleId: SALE, lifecycle: "migrated" });
  const before = queries.looks.length;
  w.socket().receive({ ...LIFECYCLE, state: "migrated" });
  assert.equal(queries.looks.length, before, "the same migration does not refetch twice");
});

test("a coin's identity change reaches every surface at once, naming the coin, even inside an activity burst", () => {
  const w = world();
  const coin = surface(w, "coin");
  const happening = surface(w, "happening");
  w.live();
  w.socket().receive(ACTIVITY);
  // Inside the burst's gap the coalescer holds both surfaces, yet the identity change is not held.
  w.advance(HINT_GAP_MS / 2);
  w.socket().receive({ ...ACTIVITY, activity_id: "326274009:4:1:0" });
  const COIN = `0x${"3f".repeat(32)}::froggy::FROGGY`;
  const METADATA = { type: "metadata", coin: COIN, cursor: "326274010:2:4294967295:0" };
  w.socket().receive(METADATA);
  const expected = { atMs: w.now(), cause: "hint", coinType: COIN };
  assert.deepEqual(coin.looks.at(-1)?.hint, expected);
  assert.deepEqual(happening.looks.at(-1)?.hint, expected);
  const before = coin.looks.length;
  w.socket().receive(METADATA);
  assert.equal(coin.looks.length, before, "the same change looks once (its cursor)");
  // A malformed coin is still only a signal: it names no coin.
  w.advance(HINT_GAP_MS);
  w.socket().receive({ type: "metadata", coin: "froggy", cursor: "326274011:1:4294967295:0" });
  w.advance(HINT_GAP_MS);
  assert.equal(coin.looks.at(-1)?.hint?.coinType, undefined);
});
