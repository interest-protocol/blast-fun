import assert from "node:assert/strict";
import test from "node:test";

import type { HomeCoinsPage, HomeQuery } from "@blast/core/modules/social/contracts/home.ts";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import type { FeedFreshnessSource, FreshnessSignal } from "../home/feed-freshness";
import { infraProvenanceFixture } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { ActivityHints, activityHints, HINT_GAP_MS, type HintSocket } from "../home/activity-hints";
import { anyFreshness } from "../home/feed-freshness";
import { buyCueOf, homeHintReads, tradeCueOf, type HomeCueTrade } from "./home-model";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useHomeLive } = await import("./use-home-live");
const { discoverQuery } = await import("./home-client");

const query: HomeQuery = { window: "1h", sort: "relevant", stage: "all", minParticipants: 0, age: "all", tradable: false, knownDeployer: false, limit: 10, page: 1, cursor: null, presales: true };
const page = { coins: [], total: 0, pages: 1, page: 1, next_cursor: null, window: "1h", clock_ms: 0, as_of: { checkpoint: 1, timestamp_ms: 0, lag_ms: 0 } } as unknown as HomeCoinsPage;

/** Home's live loop over a page cached `ageMs` ago; counts the Discover reads it starts. */
async function mount(ageMs: number) {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const { queryKey } = discoverQuery(query, true);
  client.setQueryData(queryKey, page, { updatedAt: Date.now() - ageMs });
  let reads = 0;
  const fetchQuery = client.fetchQuery.bind(client);
  client.fetchQuery = ((options: { queryKey: unknown }) => {
    if (JSON.stringify(options.queryKey) === JSON.stringify(queryKey)) reads += 1;
    return fetchQuery({ ...options, queryFn: async () => page } as never);
  }) as typeof client.fetchQuery;
  let signal: FreshnessSignal = () => undefined;
  const source: FeedFreshnessSource = { name: "fake", subscribe: (next) => ((signal = next), () => undefined) };
  function Live() {
    useHomeLive(query, true, source);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(withQueryClient(client, <Live />)));
  const connect = async (reconnect = false) => {
    signal({ atMs: Date.now(), cause: "connect", ...(reconnect ? { reconnect: true as const } : {}) });
    await settleQueries(client);
    return reads;
  };
  const done = async () => { await act(async () => root.unmount()); container.remove(); client.clear(); };
  return { connect, done };
}

test("the hint stream's first connect does not repeat a fresh page read; a reconnect reads", async () => {
  const fresh = await mount(1_000);
  try {
    assert.equal(await fresh.connect(), 0, "the server's read is younger than the poll: no second read on load");
    assert.equal(await fresh.connect(true), 1, "a reconnect may have missed hints, so it reads");
  } finally { await fresh.done(); }

  const old = await mount(31_000);
  try {
    assert.equal(await old.connect(), 1, "a page older than the poll reads on the first connect");
  } finally { await old.done(); }
});

const COIN = `0x${"b2".repeat(32)}::blast::BLAST`;
const SALE = `0x${"a1".repeat(32)}`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
let cursor = 0;
/** A trade hint as blast-infra sends it, with a new activity id each time. */
const trade = (fields: Readonly<Record<string, unknown>> = {}) =>
  ({ type: "activity", activity_id: `400:${++cursor}:0:0`, kind: "trade_buy", coin_type: COIN, quote_atoms: "2500000000", quote_type: SUI, usd: "7.25", ...fields });

/**
 * Home's live loop on the real hint client (its `homeHintReads` filter) and a poll the test fires; counts the
 * Discover reads and records each batch of buys handed to the cue. `recentBuys` is what the next read answers.
 */
async function mountLive() {
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const { queryKey } = discoverQuery(query, true);
  client.setQueryData(queryKey, page, { updatedAt: Date.now() });
  let reads = 0;
  let recentBuys: HomeCoinsPage["recent_buys"] = undefined;
  const fetchQuery = client.fetchQuery.bind(client);
  client.fetchQuery = ((options: { queryKey: unknown }) => {
    if (JSON.stringify(options.queryKey) === JSON.stringify(queryKey)) reads += 1;
    return fetchQuery({ ...options, queryFn: async () => ({ ...page, ...(recentBuys && { recent_buys: recentBuys }) }) } as never);
  }) as typeof client.fetchQuery;
  let socket: HintSocket | null = null;
  // The hint client's clock runs a coalescer gap ahead after the connect, so a fallback read is not held a second.
  let skew = 0;
  const hints = new ActivityHints({
    url: "wss://infra.blast.test/v1/ws",
    createSocket: () => (socket = { send: () => undefined, close: () => undefined, onmessage: null, onclose: null }),
    now: () => Date.now() + skew,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as number),
    random: () => 0,
    visible: () => true,
    metric: () => undefined,
  });
  let poll: FreshnessSignal = () => undefined;
  const source = anyFreshness(activityHints("home", hints, homeHintReads), { name: "poll", subscribe: (next) => ((poll = next), () => undefined) });
  const batches: HomeCueTrade[][] = [];
  function Live() {
    useHomeLive(query, true, source, (trades) => batches.push([...trades]));
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(withQueryClient(client, <Live />)));
  const send = (frame: unknown) => socket?.onmessage?.({ data: JSON.stringify(frame) });
  send({ type: "hello", engine_id: "aws-1", protocol: 1, cursor: "1:0:0:0", provenance: infraProvenanceFixture() });
  send({ type: "pong" });
  skew = HINT_GAP_MS;
  await settleQueries(client);
  return {
    send,
    batches,
    /** Waits for the 250 ms collection to hand over `count` batches, then for the reads to settle. */
    cued: async (count = 1) => { await waitFor(() => batches.length >= count, `${count} cue batch(es)`); await settleQueries(client); },
    readsReach: async (count: number) => { await waitFor(() => reads >= count, `${count} read(s)`); await settleQueries(client); },
    reads: () => reads,
    answer: (buys: HomeCoinsPage["recent_buys"]) => { recentBuys = buys; },
    poll: async () => { poll(); await settleQueries(client); },
    done: async () => { await act(async () => root.unmount()); container.remove(); client.clear(); },
  };
}

// Fails if a burst loses a trade, or a priced buy or sell hint re-reads the list.
test("three hints in one second (a sell, a buy, a bigger buy) land as one batch of pops, with no read", async () => {
  const live = await mountLive();
  try {
    const before = live.reads();
    live.send(trade({ kind: "trade_sell", usd: "500" }));
    live.send(trade({ usd: "3" }));
    live.send(trade({ usd: "42.5" }));
    await live.cued();
    assert.equal(live.batches.length, 1, "collected for 250 ms, then handed over once");
    assert.deepEqual(live.batches[0].map(tradeCueOf).map(cue => [cue?.side, cue?.text]), [["sell", "\u2212$500"], ["buy", "+$3"], ["buy", "+$43"]]);
    assert.ok(live.batches[0].every(each => each.coin_key === COIN));
    assert.equal(live.reads(), before, "priced trades make no read");
  } finally { await live.done(); }
});

// Fails if an unpriced sell loses today's read, or pops with no dollars to show.
test("a sell hint with no usd: one read, no pop", async () => {
  const live = await mountLive();
  try {
    live.send(trade({ kind: "trade_sell", usd: undefined }));
    await live.readsReach(1);
    assert.equal(live.batches.length, 0);
  } finally { await live.done(); }
});

// Fails if the poll's read repeats a cue the hint already showed.
test("a cue from a hint, then the 30 s poll read: no second cue", async () => {
  const live = await mountLive();
  try {
    const hint = trade();
    live.send(hint);
    await live.cued();
    live.answer([{ coin_key: COIN, activity_id: hint.activity_id, occurred_at_ms: Date.now(), quote_atoms: "2500000000", quote_symbol: "SUI", quote_decimals: 9, usd: "7.25" }]);
    await live.poll();
    assert.equal(live.reads(), 1, "the poll reads");
    assert.equal(live.batches.length, 1, "and finds nothing new");
  } finally { await live.done(); }
});

// Fails if an unpriced buy loses today's read or its cue.
test("a buy hint with no usd: exactly one read and one cue", async () => {
  const live = await mountLive();
  try {
    const hint = trade({ usd: undefined });
    live.answer([{ coin_key: COIN, activity_id: hint.activity_id, occurred_at_ms: Date.now() + 1_000, quote_atoms: "2500000000", quote_symbol: "SUI", quote_decimals: 9 }]);
    live.send(hint);
    await live.readsReach(1);
    await live.cued();
    assert.equal(live.reads(), 1);
    assert.equal(live.batches.length, 1);
    assert.equal(live.batches[0][0].activity_id, hint.activity_id);
    assert.equal(buyCueOf(live.batches[0][0])?.text.replace(/\s/gu, " "), "+2.5 SUI", "the read's coin figure");
  } finally { await live.done(); }
});

// Fails if a presale's buy is keyed by its coin type, so its row (keyed by the sale) never flashes.
test("a buy hint with a presale_id shows its cue on the sale's row", async () => {
  const live = await mountLive();
  try {
    live.send(trade({ presale_id: SALE, usd: "12" }));
    await live.cued();
    assert.equal(live.batches[0]?.[0]?.coin_key, SALE);
    assert.equal(live.reads(), 0);
  } finally { await live.done(); }
});

// Fails if a bad amount reaches the cue or skips the fallback read.
test("a bad or oversized amount is dropped and a fallback read follows", async () => {
  const live = await mountLive();
  try {
    live.send(trade({ usd: "1e5" }));
    await live.readsReach(1);
    // A good buy after it: its batch shows the bad one never reached the cue.
    live.send(trade({ usd: "2" }));
    await live.cued();
    assert.deepEqual(live.batches.map((batch) => batch.map((buy) => buy.usd)), [["2"]], "no cue from the bad hint");
    assert.equal(live.reads(), 1, "one fallback read");
  } finally { await live.done(); }
});

// Fails if a buy under the server's floor flashes, or a zero-atom buy does.
test("the hint cue keeps the server's floor: atoms above zero and at least $0.10", async () => {
  const live = await mountLive();
  try {
    live.send(trade({ usd: "0.099999" }));
    live.send(trade({ quote_atoms: "0", usd: "5" }));
    live.send(trade({ usd: "0.1" }));
    await live.cued();
    assert.deepEqual(live.batches.map((batch) => batch.map((buy) => buy.usd)), [["0.1"]]);
    assert.equal(live.reads(), 0, "priced buys make no read, even under the floor");
  } finally { await live.done(); }
});

// Fails if priced buys bring back the per-hint list read. Time is compressed: the hint filter does not depend on it.
test("one priced buy hint per second for 60 s: no list request except the 30 s poll", async () => {
  const live = await mountLive();
  try {
    for (let second = 0; second < 60; second += 1) live.send(trade({ usd: String(second + 1) }));
    await live.cued();
    assert.equal(live.reads(), 0);
    await live.poll();
    assert.equal(live.reads(), 1, "the poll alone reads");
  } finally { await live.done(); }
});

// Fails if a hint cue's dedup expires by the browser's clock while a read's buys carry the server's: a browser
// clock behind the server (or a cached read) would flash the same buy again after 30 s.
test("a hint cue is never repeated by a later read, whatever the clocks", async () => {
  const realNow = Date.now;
  const live = await mountLive();
  try {
    const hint = trade();
    live.send(hint);
    await live.cued();
    // 35 s later on the browser's clock. The server's clock runs ahead, so its read still lists the buy as 1 s old.
    const later = realNow() + 35_000;
    Date.now = () => later;
    live.answer([{ coin_key: COIN, activity_id: hint.activity_id, occurred_at_ms: later - 1_000, quote_atoms: "2500000000", quote_symbol: "SUI", quote_decimals: 9, usd: "7.25" }]);
    await live.poll();
    assert.equal(live.reads(), 1, "the poll reads");
    assert.equal(live.batches.length, 1, "and does not repeat the hint's cue");
  } finally {
    Date.now = realNow;
    await live.done();
  }
});
