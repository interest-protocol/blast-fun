import assert from "node:assert/strict";
import test from "node:test";

import { classifiedActivityBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/activity-fixtures.ts";
import { COIN_FIXTURE, CURVE_POOL_KEY, VENUE_POOL_KEY } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { parseClassifiedActivityPage, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";

import type { MarketStreamListener, MarketStreamRequest, MarketTrade } from "../market-stream-hub";
import { LIVE_ROWS_MAX, createActivityFeed, shownActivity, type ActivityFeedReads } from "./activity-feed";
import { FRAME_READ_FLOOR_MS, FRAME_READ_MAX_MS, followLiveTrades, provisionalActivityRow, type LiveActivityFeed } from "./activity-live";
import type { PageOutcome } from "./activity-model";
import { createTradeTape } from "./trade-tape";

const LAUNCH = COIN_FIXTURE.launchId;
const NOW = 1_790_235_061_630;
const TRADER = `0x${"7".repeat(64)}`;
/** The fixture's reads answer for this checkpoint. */
const READ_THROUGH = 326_274_009;

function frame(poolKey: string, checkpoint: number, trade: Partial<PoolTrade> = {}): MarketTrade {
  return {
    poolKey,
    checkpoint,
    summary: null,
    trade: {
      cursor: `${checkpoint}:2:0:0`,
      timestampMs: NOW,
      digest: "9KJ7rvTzZ8wL5V3bK4n2sQe1Xy6pD8fH3mN5cR7tA2uB",
      trader: TRADER,
      side: "buy",
      kind: "buy",
      quoteAmount: 2_000_000_000n,
      memeAmount: 41_000_000n,
      price: null,
      volumeUsd: null,
      venueSwap: null,
      ...trade,
    },
  };
}

test("a trade frame becomes the row blast-infra classifies from the same trade, or nothing when it cannot say all of it", () => {
  const row = (poolKey: string, trade: Partial<PoolTrade>) => provisionalActivityRow(LAUNCH, frame(poolKey, 326_274_100, trade));
  assert.deepEqual(row(CURVE_POOL_KEY, {}), {
    position: "326274100:2:0:0",
    checkpoint: 326_274_100,
    timestampMs: NOW,
    digest: "9KJ7rvTzZ8wL5V3bK4n2sQe1Xy6pD8fH3mN5cR7tA2uB",
    kind: "curve_buy",
    source: "user",
    actor: TRADER,
    lifecycle: null,
    amounts: { quote: 2_000_000_000n, meme: 41_000_000n },
  });
  const shape = (poolKey: string, trade: Partial<PoolTrade>) => {
    const mapped = row(poolKey, trade);
    return mapped && [mapped.kind, mapped.source];
  };
  assert.deepEqual(shape(CURVE_POOL_KEY, { kind: "pre_share_buy" }), ["curve_buy", "creator_pre_share"]);
  assert.deepEqual(shape(CURVE_POOL_KEY, { kind: "sell", side: "sell" }), ["curve_sell", "user"]);
  assert.deepEqual(shape(VENUE_POOL_KEY, { kind: "swap", side: "buy" }), ["venue_buy", VENUE_POOL_KEY]);
  assert.deepEqual(shape(VENUE_POOL_KEY, { kind: "swap", side: "sell" }), ["venue_sell", VENUE_POOL_KEY]);
  assert.deepEqual(row(CURVE_POOL_KEY, { whale: true })?.labels, ["whale"]);
  // The opening round settles to a row with no actor, and its fills are no rows of their own.
  assert.equal(row(CURVE_POOL_KEY, { kind: "opening_round" }), null);
  assert.equal(row(CURVE_POOL_KEY, { kind: "opening_round_fill" }), null);
  assert.equal(row(CURVE_POOL_KEY, { trader: null }), null);
  assert.equal(row(CURVE_POOL_KEY, { kind: "sell", side: "buy" }), null);
  assert.equal(row(CURVE_POOL_KEY, { cursor: "326274099:2:0:0" }), null, "a cursor outside the frame's checkpoint");
  assert.equal(row(`blast_curve:0x${"b".repeat(64)}`, {}), null, "another launch's curve");
  assert.equal(row(VENUE_POOL_KEY, { kind: "buy" }), null);
});

/** A hub that hands the test its one subscriber. */
function fakeHub() {
  const subscribed: MarketStreamRequest[] = [];
  let stopped = 0;
  const hub = {
    subscribe: (request: MarketStreamRequest) => {
      subscribed.push(request);
      return { state: () => "live" as const, ready: () => true, stop: () => void stopped++ };
    },
  };
  const listener = (): MarketStreamListener => subscribed.at(-1)!.listener;
  return { hub, subscribed, listener, stopped: () => stopped };
}

/** Timers the test runs by hand. */
function fakeClock() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  let now = 1_000_000;
  return {
    timers,
    now: () => now,
    advance: (ms: number) => void (now += ms),
    schedule: (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    fire: () => {
      const timer = timers.shift()!;
      if (!timer.cancelled) timer.run();
    },
  };
}

function page(rows: readonly ActivityRow[], checkpoint: number, next: string | null = null): PageOutcome<ActivityRow> {
  const body = classifiedActivityBody("migrated", {}, NOW);
  const provenance = parseInfraProvenance(body.provenance);
  return { kind: "rows", rows, next, provenance: { ...provenance, checkpoint }, lagging: false };
}

test("trade frames show once, newest first, and the next read's rows take their place without a gap", async () => {
  const fixture = parseClassifiedActivityPage(LAUNCH, classifiedActivityBody("migrated", {}, NOW));
  let newest = page(fixture.activity, READ_THROUGH, fixture.nextCursor);
  const reads: ActivityFeedReads = { activity: async () => newest, flow: async () => ({ kind: "failed", reason: "not_ready" }) };
  const feed = createActivityFeed({ reads, start: null });
  await feed.refresh(false);
  const { hub, listener, subscribed, stopped } = fakeHub();
  const clock = fakeClock();
  const stop = followLiveTrades({
    hub,
    launchId: LAUNCH,
    pools: [CURVE_POOL_KEY, VENUE_POOL_KEY],
    expected: null,
    feed,
    onState: () => {},
    schedule: clock.schedule,
    now: clock.now,
    random: () => 0,
  });
  assert.deepEqual(subscribed[0]!.pools, [CURVE_POOL_KEY, VENUE_POOL_KEY]);
  assert.equal(subscribed[0]!.migration, undefined, "trades only: no candle frames");

  const shown = () => shownActivity(feed.state()).view!.rows.map((row) => row.position);
  const before = shown();
  listener().fence!(VENUE_POOL_KEY, READ_THROUGH, { lastEvent: READ_THROUGH });
  const first = frame(VENUE_POOL_KEY, READ_THROUGH + 1, { kind: "swap" });
  const second = frame(VENUE_POOL_KEY, READ_THROUGH + 2, { kind: "swap", side: "sell", volumeUsd: "0.999" });
  listener().trade!(first);
  listener().trade!(second);
  listener().trade!(first);
  // A frame the list already read through is no new row.
  listener().trade!(frame(VENUE_POOL_KEY, READ_THROUGH, { kind: "swap", cursor: `${READ_THROUGH}:9:0:0` }));
  assert.deepEqual(shown(), [`${READ_THROUGH + 2}:2:0:0`, `${READ_THROUGH + 1}:2:0:0`, ...before]);
  assert.equal(clock.timers.length, 0, "mapped frames and a fence already read through ask for no read");

  // The next poll answers with both trades as classified rows: every state the list passes through shows each once.
  assert.equal(shownActivity(feed.state()).view!.rows[0]?.volumeUsd, "0.999");
  const rest = [second, first].map((item) => provisionalActivityRow(LAUNCH, {
    ...item, trade: { ...item.trade, volumeUsd: null },
  })!);
  newest = page([...rest, ...fixture.activity], READ_THROUGH + 2, fixture.nextCursor);
  const seen: string[][] = [];
  const unsubscribe = feed.subscribe(() => seen.push(shown()));
  await feed.refresh(false);
  unsubscribe();
  assert.ok(seen.length > 0);
  for (const rows of seen) assert.deepEqual(rows, [`${READ_THROUGH + 2}:2:0:0`, `${READ_THROUGH + 1}:2:0:0`, ...before]);
  assert.equal(feed.state().live.length, 0, "the read answered for every provisional row");
  assert.equal(shownActivity(feed.state()).view!.rows[0]?.volumeUsd, "0.999", "the trade retains its recorded USD after confirmation");
  await feed.refresh(false);
  assert.equal(shownActivity(feed.state()).view!.rows[0]?.volumeUsd, "0.999", "subsequent reads retain the recorded USD");
  assert.equal(shownActivity(feed.state()).view!.rows[0], feed.state().activity.view!.rows[0], "the row shown is the read's");

  stop();
  assert.equal(stopped(), 1);
});

test("the compact tape shows a burst one trade at a time, even when history confirms it before the next beat", async () => {
  const initial = parseClassifiedActivityPage(LAUNCH, classifiedActivityBody("live", { limit: 100 }, NOW));
  let newest = page(initial.activity, READ_THROUGH);
  const feed = createActivityFeed({
    start: null,
    reads: { activity: async () => newest, flow: async () => ({ kind: "failed", reason: "not_ready" }) },
  });
  const clock = fakeClock();
  let instant = false;
  let settingChanged = () => {};
  const tape = createTradeTape(feed, {
    instant: () => instant,
    observe: (sync) => { settingChanged = sync; return () => {}; },
    schedule: clock.schedule,
  });
  const stop = tape.subscribe(() => {});
  const current = () => tape.snapshot().rows[0];
  const trade = (offset: number) => provisionalActivityRow(LAUNCH, frame(CURVE_POOL_KEY, READ_THROUGH + offset))!;

  await feed.refresh(false);
  const original = current();
  assert.ok(original);
  assert.equal(tape.snapshot().entering, null, "history is still on first paint");

  const first = trade(1);
  const second = trade(2);
  feed.addLive(first);
  feed.addLive(second);
  assert.equal(current()?.position, first.position);
  assert.equal(tape.snapshot().rows.some((row) => row.position === second.position), false);

  newest = page([{ ...second, labels: ["sniper"] }, { ...first }, ...initial.activity], READ_THROUGH + 2);
  await feed.refresh(false);
  assert.equal(current(), first, "a matching history row preserves its render identity");
  assert.equal(tape.snapshot().rows[1], original, "other rows retain their render identity");
  assert.equal(tape.snapshot().rows.some((row) => row.position === second.position), false, "history cannot reveal a queued trade early");

  clock.fire();
  assert.equal(current()?.position, second.position);
  assert.deepEqual(current()?.labels, ["sniper"], "the queued trade takes the confirmed values");
  assert.equal(tape.snapshot().rows[1], first);

  tape.hold(true);
  feed.addLive(trade(3));
  clock.fire();
  assert.equal(current()?.position, second.position, "keyboard focus holds the tape");
  tape.hold(false);
  assert.equal(current()?.position, trade(3).position);

  feed.addLive(trade(4));
  instant = true;
  settingChanged();
  assert.equal(current()?.position, trade(4).position);
  assert.equal(tape.snapshot().slide, false, "reduced motion flushes without a slide");
  assert.equal(tape.snapshot().entering, trade(4).position, "the color cue is still available");
  stop();
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a gap or reconnect asks for one read pinned to the newest checkpoint, at most once per floor, again until it reaches it", async () => {
  const { hub, listener } = fakeHub();
  const clock = fakeClock();
  const reads: (number | null | undefined)[] = [];
  let readThrough: number | null = 100;
  // What a read answers through: its checkpoint, unless the test holds it back.
  let answers = (at: number) => at;
  const feed: LiveActivityFeed = {
    addLive: () => assert.fail("no frame here maps to a row"),
    readThrough: () => readThrough,
    refresh: async (_manual, at) => {
      reads.push(at);
      readThrough = answers(at!);
      return true;
    },
  };
  const stop = followLiveTrades({ hub, launchId: LAUNCH, pools: [CURVE_POOL_KEY], expected: null, feed, onState: () => {}, schedule: clock.schedule, now: clock.now, random: () => 0.5 });
  const delays = () => clock.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms);
  listener().fence!(CURVE_POOL_KEY, 100, { lastEvent: 100 });
  assert.deepEqual(delays(), [], "a fence the list has read through");

  // A reconnect's fence, then a frame the list cannot show: one read, at the newer checkpoint.
  listener().fence!(CURVE_POOL_KEY, 101, { lastEvent: 101 });
  listener().trade!(frame(CURVE_POOL_KEY, 103, { kind: "opening_round" }));
  assert.deepEqual(delays(), [500]);
  clock.fire();
  await settle();
  assert.deepEqual(reads, [103]);
  assert.deepEqual(delays(), [], "it reached its checkpoint");

  // The next one waits out the floor from the last read, and a poll that reads through it meanwhile makes it moot.
  clock.advance(1_000);
  listener().trade!(frame(CURVE_POOL_KEY, 105, { trader: null }));
  assert.deepEqual(delays(), [FRAME_READ_FLOOR_MS - 1_000 + 500]);
  readThrough = 105;
  clock.fire();
  await settle();
  assert.deepEqual(reads, [103]);

  // A read that fails or answers behind is asked again, the floor doubling up to the live poll's pace.
  answers = () => 105;
  clock.advance(60_000);
  listener().fence!(CURVE_POOL_KEY, 107, { lastEvent: 107 });
  const retries: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    retries.push(...delays());
    clock.fire();
    await settle();
  }
  assert.deepEqual(retries, [500, 10_500, 20_500, FRAME_READ_MAX_MS + 500]);
  assert.deepEqual(reads, [103, 107, 107, 107, 107]);
  answers = (at) => at;
  clock.fire();
  await settle();
  assert.deepEqual(reads.at(-1), 107);
  assert.deepEqual(delays(), [], "reached: no more reads");

  // A read in flight when the list goes away asks nothing more.
  answers = () => 107;
  clock.advance(60_000);
  listener().fence!(CURVE_POOL_KEY, 110, { lastEvent: 110 });
  clock.fire();
  stop();
  await settle();
  assert.deepEqual(delays(), []);
  listener().fence!(CURVE_POOL_KEY, 111, { lastEvent: 111 });
  assert.deepEqual(reads.at(-1), 110);
});

test("before the list's first answer a frame read waits a whole floor, and a row past the cap asks for a read too", () => {
  const { hub, listener } = fakeHub();
  const clock = fakeClock();
  let full = false;
  const reads: (number | null | undefined)[] = [];
  const feed: LiveActivityFeed = {
    addLive: () => full,
    readThrough: () => null,
    refresh: async (_manual, at) => {
      reads.push(at);
      return true;
    },
  };
  followLiveTrades({ hub, launchId: LAUNCH, pools: [CURVE_POOL_KEY], expected: null, feed, onState: () => {}, schedule: clock.schedule, now: clock.now, random: () => 0 });
  const delays = () => clock.timers.map((timer) => timer.ms);
  listener().trade!(frame(CURVE_POOL_KEY, 49));
  assert.deepEqual(delays(), [], "a row the list holds needs no read");
  listener().fence!(CURVE_POOL_KEY, 50, { lastEvent: 50 });
  assert.deepEqual(delays(), [FRAME_READ_FLOOR_MS]);
  // A row past the cap asks for the read that brings back the one it pushed out.
  full = true;
  listener().trade!(frame(CURVE_POOL_KEY, 51));
  assert.deepEqual(delays(), [FRAME_READ_FLOOR_MS], "coalesced into the waiting read");
  clock.fire();
  assert.deepEqual(reads, [51]);
});

test("under the small-trade filter a burst of dust frames takes no row and asks no read; a real trade still shows, and turning the filter off reads the dust once", () => {
  const { hub, listener } = fakeHub();
  const clock = fakeClock();
  const added: string[] = [];
  const reads: (number | null | undefined)[] = [];
  const feed: LiveActivityFeed = {
    // Past the cap every added row would ask for a read.
    addLive: (row) => (added.push(row.position), added.length > LIVE_ROWS_MAX),
    readThrough: () => READ_THROUGH,
    refresh: async (_manual, at) => (reads.push(at), true),
  };
  const dust = (row: ActivityRow) => Number(row.volumeUsd ?? "1") < 1;
  const follow = followLiveTrades({ hub, launchId: LAUNCH, pools: [CURVE_POOL_KEY], expected: null, feed, hides: dust, onState: () => {}, schedule: clock.schedule, now: clock.now, random: () => 0 });
  for (let index = 1; index <= LIVE_ROWS_MAX * 2; index++) listener().trade!(frame(CURVE_POOL_KEY, READ_THROUGH + index, { volumeUsd: "0.01" }));
  assert.deepEqual(added, [], "dust takes no row");
  assert.equal(clock.timers.length, 0, "dust asks for no read");
  listener().trade!(frame(CURVE_POOL_KEY, READ_THROUGH + 100, { volumeUsd: "25.00" }));
  assert.deepEqual(added, [`${READ_THROUGH + 100}:2:0:0`], "a real trade still shows at once");
  assert.equal(clock.timers.length, 0);

  follow.showHidden();
  follow.showHidden();
  assert.equal(clock.timers.length, 1, "turning the filter off asks for one read");
  clock.fire();
  assert.deepEqual(reads, [READ_THROUGH + LIVE_ROWS_MAX * 2], "through the newest dust trade");
  follow();
});

test("provisional rows stay bounded: one page at most, none on a link's list, and a newer page offered beside loaded pages answers for them", async () => {
  const fixture = parseClassifiedActivityPage(LAUNCH, classifiedActivityBody("migrated", {}, NOW));
  let newest = page(fixture.activity, READ_THROUGH, fixture.nextCursor);
  const older = parseClassifiedActivityPage(LAUNCH, classifiedActivityBody("migrated", { cursor: fixture.nextCursor }, NOW));
  const reads: ActivityFeedReads = {
    activity: async (cursor) => (cursor === null ? newest : page(older.activity, READ_THROUGH, older.nextCursor)),
    flow: async () => ({ kind: "failed", reason: "not_ready" }),
  };
  const feed = createActivityFeed({ reads, start: null });
  await feed.refresh(false);
  const row = (checkpoint: number) => provisionalActivityRow(LAUNCH, frame(VENUE_POOL_KEY, checkpoint, { kind: "swap" }))!;
  const overflowed = Array.from({ length: 40 }, (_, index) => feed.addLive(row(READ_THROUGH + 1 + index)));
  assert.equal(overflowed.indexOf(true), LIVE_ROWS_MAX, "the first row past the cap says so");
  assert.equal(feed.state().live.length, LIVE_ROWS_MAX);
  assert.equal(feed.state().live[0]!.checkpoint, READ_THROUGH + 40, "the newest stay");

  const linked = createActivityFeed({ reads, start: fixture.activity[3]!.position });
  linked.addLive(row(READ_THROUGH + 41));
  assert.equal(linked.state().live.length, 0);

  // Two pages loaded: a first page that cannot reach them is only offered, and it answers for what it covers.
  await feed.more();
  newest = page([{ ...fixture.activity[0]!, position: `${READ_THROUGH + 30}:0:0:0`, checkpoint: READ_THROUGH + 30 }], READ_THROUGH + 30, "more");
  await feed.refresh(false);
  assert.ok(feed.state().activity.newer);
  assert.deepEqual(feed.state().live.map((held) => held.checkpoint), Array.from({ length: 10 }, (_, index) => READ_THROUGH + 40 - index));
  assert.equal(feed.readThrough(), READ_THROUGH + 30);
  feed.addLive(row(READ_THROUGH + 20));
  assert.equal(feed.state().live.length, 10, "a row the offered page covers is not added");
  assert.equal(shownActivity(feed.state()), feed.state().activity, "the list waits for Show newer, rows and all");
  feed.showNewer();
  assert.deepEqual(
    shownActivity(feed.state()).view!.rows.map((shown) => shown.checkpoint),
    [...Array.from({ length: 10 }, (_, index) => READ_THROUGH + 40 - index), READ_THROUGH + 30],
  );
});
