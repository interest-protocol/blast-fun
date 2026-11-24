import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { installHappeningSource } from "../../../../test/fixtures/social/happening/store-boundaries.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
const dom = installTestDom();
afterEach(() => mock.restoreAll());

import { infraProvenanceFixture } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";

import { fundedSince } from "../celebration/celebration-model";
import { FIXTURE_NOW } from "../../../../test/fixtures/social/feed-fixtures.ts";
import { ActivityHints, activityHints, HINT_GAP_MS, type HintSocket } from "../home/activity-hints";
import type { FreshnessHint } from "../home/feed-freshness";
import { happeningRead, tapeEvent } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
const { HappeningStore } = await import("./happening-store");

/**
 * R3-26 on Home's live store: the activity hint makes the store read
 * `GET /api/social/happening` within a second (and within its 5 s floor), and
 * what is shown comes only from that read, whatever the hint said.
 */

class FakeSocket implements HintSocket {
  sent: unknown[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {
    this.closed = true;
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const HELLO = { type: "hello", engine_id: "aws-1", protocol: 1, cursor: "326274009:3:1:0", provenance: infraProvenanceFixture() };
const TIDE_ID = `0x${"a4".padStart(64, "0")}`;
/** A sale the web never shows (`SHOWN_PRESALES` drops it, e.g. an excluded test sale). */
const HIDDEN_ID = `0x${"dead".padStart(64, "0")}`;

/** The store on the real hint client, over one fake clock, timer queue, socket and fetch. */
function harness(answers: SocialHappeningResponse[]) {
  let now = 1_000_000;
  let ids = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  const sockets: FakeSocket[] = [];
  const fetched: { url: string; credentials: RequestCredentials | undefined; at: number }[] = [];
  const painted: { hint: FreshnessHint; at: number }[] = [];
  const setTimeout = (run: () => void, ms: number) => {
    const id = ++ids;
    timers.push({ at: now + ms, run, id });
    return id;
  };
  const clearTimeout = (handle: unknown) => {
    const index = timers.findIndex((timer) => timer.id === handle);
    if (index >= 0) timers.splice(index, 1);
  };
  const hub = new ActivityHints({
    url: "wss://infra.blast.test/v1/ws",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    setTimeout,
    clearTimeout,
    random: () => 0.5,
    visible: () => true,
    metric: () => undefined,
  });
  installHappeningSource(activityHints("happening", hub), (hint) => painted.push({ hint, at: now }));
  mock.method(Date, "now", () => now);
  mock.method(dom.window, "matchMedia", () => ({ matches: true }) as MediaQueryList);
  mock.method(dom.window, "setTimeout", setTimeout as typeof window.setTimeout);
  mock.method(dom.window, "clearTimeout", clearTimeout);
  mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetched.push({ url: String(url), credentials: init?.credentials, at: now });
    const answer = answers.shift();
    return answer ? Response.json(answer) : new Response("{}", { status: 500 });
  });
  const store = new HappeningStore(createTestQueryClient());
  const settle = async () => {
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    store,
    hub,
    fetched,
    painted,
    timers,
    socket: () => sockets[sockets.length - 1],
    now: () => now,
    /** Moves the clock, running due timers in order and letting their reads settle. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = timers[0];
        if (!due || due.at > until) break;
        timers.shift();
        now = due.at;
        due.run();
        await settle();
      }
      now = until;
      await settle();
    },
    async hint(frame: Record<string, unknown>) {
      sockets[sockets.length - 1].receive(frame);
      await settle();
    },
  };
}

const first = happeningRead();
const second = happeningRead({
  clock_ms: first.clock_ms + 10_000,
  last_hour: { wallets: 320, usd: "49000.00" },
  tape: [tapeEvent({ activity_id: "326274009:3:1:0", occurred_at_ms: FIXTURE_NOW - 1_000, usd: "250.00" }), ...first.tape],
});

test("R3-26-AC-1/AC-2: a hint makes the store read at once; what is shown is that read, never the hint's fabricated amounts", async () => {
  const h = harness([first, second]);
  h.store.seed(first);
  const off = h.store.subscribe(() => undefined);
  assert.equal(h.fetched.length, 0, "the server's read is fresh");
  h.socket().receive(HELLO);
  h.socket().receive({ type: "pong" });
  // The connect look lands inside the 5 s floor of the server's read: it is kept, and read when the floor passes.
  await h.advance(4_999);
  assert.equal(h.fetched.length, 0);
  await h.advance(1);
  assert.deepEqual(h.fetched.map((read) => read.at - 1_000_000), [5_000]);
  assert.deepEqual(h.painted.map((paint) => paint.hint.cause), ["connect"], "reported, and recordHintPainted drops it: a connect is no hint latency");

  await h.advance(10_000);
  const hintAt = h.now();
  await h.hint({
    type: "activity",
    activity_id: "326274009:3:1:0",
    kind: "presale_commit",
    presale_id: TIDE_ID,
    coin_type: null,
    timestamp_ms: 1_790_235_061_218,
    // Fabricated: nothing below may reach the screen.
    usd: "9999999.00",
    amount: "77777777777777",
    last_hour: { wallets: 888_888, usd: "66666666.00" },
    tape: [{ activity_id: "666:6:6:6", usd: "5555555.00", symbol: "EVIL" }],
  });
  assert.deepEqual(h.fetched.map((read) => read.at - hintAt), [-10_000, 0], "read at once: no floor or gap was in the way");
  assert.ok(h.fetched.every((read) => read.url === "/api/social/happening?recent_presales=1" && read.credentials === "same-origin"), "the public read, signed in or out");
  assert.deepEqual(h.painted.map((paint) => ({ cause: paint.hint.cause, ms: paint.at - paint.hint.atMs })), [
    { cause: "connect", ms: 5_000 },
    { cause: "hint", ms: 0 },
  ]);

  const shown = h.store.getSnapshot();
  assert.deepEqual(shown.read, second, "the snapshot is the HTTP read, exactly");
  assert.deepEqual(shown.tape.map((event) => [event.activity_id, event.usd]), second.tape.map((event) => [event.activity_id, event.usd]), "the read's tape");
  assert.doesNotMatch(JSON.stringify(shown), /"(9999999\.00|77777777777777|66666666\.00|5555555\.00|EVIL|666:6:6:6)"|:888888\b/, "no figure from the hint");
  off();
  assert.equal(h.hub.active(), false, "the last surface closed the socket");
  assert.equal(h.timers.length, 0);
});

test("R3-26: a hint inside the 5 s floor is read once the floor passes (not at the next poll), and a burst reads twice at most", async () => {
  const h = harness([second, second, second, second]);
  h.store.seed(first);
  h.store.subscribe(() => undefined);
  h.socket().receive(HELLO);
  h.socket().receive({ type: "pong" });
  await h.advance(5_000); // the connect look's read
  await h.advance(5_000);
  const start = h.now();
  for (let index = 0; index < 50; index += 1) {
    await h.hint({ type: "activity", activity_id: `326274010:${index}:0:0`, kind: "presale_commit", presale_id: TIDE_ID, coin_type: null, timestamp_ms: 1 });
    await h.advance(20);
  }
  await h.advance(30_000);
  const reads = h.fetched.map((read) => read.at - start).filter((at) => at >= 0);
  // At once for the first hint, and once at the end of the floor for the 49 that came after that read began.
  assert.deepEqual(reads, [0, 5_000]);
  // The kept look counts from the first hint it held back.
  assert.deepEqual(h.painted.filter((paint) => paint.hint.cause === "hint").map((paint) => paint.at - paint.hint.atMs), [0, 5_000 - 20]);
});

test("R3-26: a hint for a sale the viewer cannot see changes nothing on screen", async () => {
  // The client half only. The read here is a canned answer that already leaves the hidden sale out, so this proves that
  // the hint itself puts nothing on screen. That the route leaves it out is proven against Postgres in
  // happening.integration.test.ts ("T-043 hidden sales: …"); until 2026-10-05 its tape and last hour did not.
  const h = harness([second, second]);
  h.store.seed(second);
  const funded: string[] = [];
  h.store.watchReads((previous, next) => {
    for (const row of fundedSince(previous, next)) funded.push(row.presale.presale_id);
  });
  h.store.subscribe(() => undefined);
  h.socket().receive(HELLO);
  h.socket().receive({ type: "pong" });
  await h.advance(10_000);
  const before = h.store.getSnapshot().read;
  const tape = h.store.getSnapshot().tape.map((event) => event.activity_id);
  await h.advance(HINT_GAP_MS);
  await h.hint({ type: "activity", activity_id: "326274099:0:0:0", kind: "presale_commit", presale_id: HIDDEN_ID, coin_type: null, timestamp_ms: 1 });
  await h.hint({ type: "presale_lifecycle", presale_id: HIDDEN_ID, state: "funded", timestamp_ms: 2 });
  await h.advance(10_000);
  assert.deepEqual(h.store.getSnapshot().read, before);
  assert.deepEqual(h.store.getSnapshot().tape.map((event) => event.activity_id), tape);
  assert.deepEqual(funded, [], "no celebration for a sale the viewer cannot see");
});
