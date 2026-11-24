import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { installHappeningSource } from "../../../../test/fixtures/social/happening/store-boundaries.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
const dom = installTestDom();
afterEach(() => mock.restoreAll());

import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";

import type { FeedFreshnessSource } from "../home/feed-freshness";
import { happeningRead, tapeEvent } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
const { HappeningStore, fetchHappening } = await import("./happening-store");
type HappeningStore = InstanceType<typeof HappeningStore>;

/** A store with a manual freshness source, clock, timers and fetch. */
function harness(options: Readonly<{ reduce?: boolean; visible?: boolean; answers?: (SocialHappeningResponse | number)[] }> = {}) {
  let signal: (() => void) | null = null;
  let now = 1_000_000;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const fetched: string[] = [];
  const answers = [...(options.answers ?? [])];
  const source: FeedFreshnessSource = { name: "manual", subscribe: (next) => { signal = next; return () => { signal = null; }; } };
  installHappeningSource(source);
  mock.method(Date, "now", () => now);
  mock.getter(dom.document, "visibilityState", () => options.visible === false ? "hidden" : "visible");
  mock.method(dom.window, "matchMedia", () => ({ matches: options.reduce ?? false }) as MediaQueryList);
  mock.method(dom.window, "setTimeout", ((run: () => void, ms: number) => { const id = ++ids; timers.push({ at: now + ms, run, id }); return id; }) as typeof window.setTimeout);
  mock.method(dom.window, "clearTimeout", (handle: number | undefined) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); });
  mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
    // The test-sale lookup (lib/test-launches.ts) is not what these tests count; failing it hides nothing.
    if (String(url).startsWith("/api/social/home/coins")) return new Response("{}", { status: 500 });
    fetched.push(String(url));
    const answer = answers.shift() ?? 500;
    return typeof answer === "number" ? new Response("{}", { status: answer }) : Response.json(answer);
  });
  const store = new HappeningStore(createTestQueryClient());
  return {
    store,
    fetched,
    signal: async () => { signal?.(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); },
    advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > now) break;
        timers.shift();
        due.run();
      }
    },
    subscribed: () => signal !== null,
  };
}

const ids = (store: HappeningStore) => store.getSnapshot().tape.map((event) => event.activity_id);
const first = happeningRead({ tape: [tapeEvent({ activity_id: "2:0:0:0", occurred_at_ms: 20 }), tapeEvent({ activity_id: "1:0:0:0", occurred_at_ms: 10 })] });
const next = happeningRead({
  clock_ms: first.clock_ms + 30_000,
  last_hour: { wallets: 320, usd: "49000.00" },
  tape: [
    tapeEvent({ activity_id: "4:0:0:0", occurred_at_ms: 40 }),
    tapeEvent({ activity_id: "3:0:0:0", occurred_at_ms: 30 }),
    tapeEvent({ activity_id: "2:0:0:0", occurred_at_ms: 20 }),
    tapeEvent({ activity_id: "1:0:0:0", occurred_at_ms: 10 }),
  ],
});

test("UI-05 store: polls only while subscribed, never sooner than 5 s after the server's read, and only while visible", async () => {
  const h = harness({ answers: [next] });
  h.store.seed(first);
  assert.equal(h.subscribed(), false);
  const off = h.store.subscribe(() => undefined);
  assert.equal(h.subscribed(), true);
  await h.signal();
  assert.deepEqual(h.fetched, [], "the server's read is fresh: the gate starts at subscribe");
  h.advance(5_000);
  await h.signal();
  assert.deepEqual(h.fetched, ["/api/social/happening?recent_presales=1"]);
  off();
  assert.equal(h.subscribed(), false);
  const hidden = harness({ visible: false });
  hidden.store.seed(first);
  hidden.store.subscribe(() => undefined);
  hidden.advance(6_000);
  await hidden.signal();
  assert.deepEqual(hidden.fetched, []);
});

test("UI-05 store: new tape events slide in one at a time, oldest first, while the figures update at once", async () => {
  const h = harness({ answers: [next] });
  h.store.seed(first);
  let notified = 0;
  h.store.subscribe(() => { notified += 1; });
  h.advance(5_000);
  await h.signal();
  assert.equal(h.store.getSnapshot().read?.last_hour.wallets, 320);
  assert.deepEqual(ids(h.store), ["2:0:0:0", "1:0:0:0"]);
  h.advance(0);
  assert.deepEqual(ids(h.store), ["3:0:0:0", "2:0:0:0", "1:0:0:0"]);
  assert.ok(h.store.getSnapshot().arrived.has("3:0:0:0"));
  h.advance(3_999);
  assert.equal(ids(h.store).length, 3);
  h.advance(1);
  assert.deepEqual(ids(h.store), ["4:0:0:0", "3:0:0:0", "2:0:0:0", "1:0:0:0"]);
  assert.ok(notified >= 3);
});

test("UI-05 store: the row pushed out of the visible four collapses, then goes", () => {
  const h = harness();
  const four = ["4", "3", "2", "1"].map((n) => tapeEvent({ activity_id: `${n}:0:0:0`, occurred_at_ms: Number(n) * 10 }));
  h.store.seed(happeningRead({ tape: four }));
  h.store.subscribe(() => undefined);
  h.store.apply(happeningRead({ clock_ms: 2, tape: [tapeEvent({ activity_id: "5:0:0:0", occurred_at_ms: 50 }), ...four] }));
  h.advance(0);
  assert.equal(h.store.getSnapshot().leaving?.activity_id, "1:0:0:0");
  h.advance(320);
  assert.equal(h.store.getSnapshot().leaving, null);
});

test("UI-05 store: with reduced motion new events land at once; a failed read keeps what is shown", async () => {
  const h = harness({ reduce: true, answers: [next, 503] });
  h.store.seed(first);
  h.store.subscribe(() => undefined);
  h.advance(5_000);
  await h.signal();
  assert.deepEqual(ids(h.store), ["4:0:0:0", "3:0:0:0", "2:0:0:0", "1:0:0:0"]);
  assert.equal(h.store.getSnapshot().arrived.size, 0);
  h.advance(5_000);
  await h.signal();
  assert.equal(h.fetched.length, 2);
  assert.equal(h.store.getSnapshot().read?.last_hour.wallets, 320);
});

test("UI-05 store: without a server read it reads at once; an older server read never replaces a newer one", async () => {
  const h = harness({ answers: [first] });
  h.store.subscribe(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.fetched, ["/api/social/happening?recent_presales=1"]);
  assert.equal(h.store.getSnapshot().read?.clock_ms, first.clock_ms);
  h.store.seed(next);
  h.store.seed(first);
  assert.equal(h.store.getSnapshot().read?.clock_ms, next.clock_ms);
});

test("UI-15 store: watchers hear each new read with the one it replaced, and watching alone never reads", async () => {
  const h = harness({ answers: [next] });
  const heard: [number | null, number][] = [];
  const off = h.store.watchReads((previous, read) => heard.push([previous?.clock_ms ?? null, read.clock_ms]));
  h.store.seed(first);
  await Promise.resolve();
  assert.deepEqual(heard, [], "a first read replaces nothing");
  assert.deepEqual(h.fetched, [], "a watcher does not start the poll");
  h.store.apply(next);
  assert.deepEqual(heard, [[first.clock_ms, next.clock_ms]]);
  // A newer server read seeded while a page renders is told after the render.
  const later = { ...next, clock_ms: next.clock_ms + 30_000 };
  h.store.seed(later);
  assert.equal(heard.length, 1);
  await Promise.resolve();
  assert.deepEqual(heard[1], [next.clock_ms, later.clock_ms]);
  off();
  h.store.apply({ ...later, clock_ms: later.clock_ms + 1 });
  assert.equal(heard.length, 2);
});

test("an initial failed read leaves loading, then a retry recovers without a fake empty read", async () => {
  const h = harness({ answers: [503, first] });
  assert.equal(h.store.getSnapshot().read, null);
  assert.equal(h.store.getSnapshot().failed, undefined);
  const stop = h.store.subscribe(() => undefined);
  await h.signal();
  assert.equal(h.store.getSnapshot().read, null);
  assert.equal(h.store.getSnapshot().failed, true);
  h.advance(5_000);
  await h.signal();
  assert.deepEqual(h.store.getSnapshot().read, first);
  assert.equal(h.store.getSnapshot().failed, undefined);
  stop();
});


test("initial live read failures keep the HTTP diagnostic and hide response details", async () => {
  for (const response of [
    Response.json({ error: { code: "service_unavailable", message: "private database detail" } }, { status: 503, headers: { "X-Request-ID": "live-read-reference" } }),
    Response.json({ private: "malformed success detail" }, { headers: { "X-Request-ID": "live-invalid-reference" } }),
  ]) {
    mock.method(globalThis, "fetch", async () => response.clone());
    installHappeningSource({ name: "none", subscribe: () => () => undefined });
    const store = new HappeningStore(createTestQueryClient());
    await store.refresh();
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.failed, true);
    assert.equal(snapshot.read, null);
    assert.match(snapshot.errorMessage ?? "", response.ok ? /Code: invalid_response\. Reference: live-invalid-reference\./ : /Code: service_unavailable\. Reference: live-read-reference\./);
    assert.doesNotMatch(snapshot.errorMessage ?? "", /private database detail|malformed success detail/);
  }
});


test("Happening rejects malformed nested tape rows at the response boundary", async () => {
  const body = happeningRead({ tape: [tapeEvent({ kind: "presale_claim", tokens: "0.000000000000000000000001" })] });
  mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.deepEqual(await fetchHappening(), body);
  mock.method(globalThis, "fetch", async () => Response.json({ ...body, tape: [{}] }));
  await assert.rejects(fetchHappening(), /unreadable response/);
});
