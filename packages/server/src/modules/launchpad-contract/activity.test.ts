import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import {
  activityAnchor,
  activityCursor,
  biddersCursor,
  biddersPath,
  classifiedActivityPath,
  countsAsUserTrade,
  isActivityTrade,
  parseBiddersPage,
  parseClassifiedActivityPage,
  parseCurveFlow,
  parseOpeningRound,
  parseWindowFlow,
  readClassifiedActivity,
  readCurveFlow,
  readOpeningBidders,
} from "@blast/core/modules/launchpad-contract/activity.ts";
import { CursorError, decodeCursor, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { parseLaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { FIXTURE_TIMESTAMP_MS, infraProvenanceFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";

const ORIGIN = "https://api.blast.test";
const LAUNCH = `0x${"a1b2c3d4".repeat(8)}`;
const OTHER = `0x${"7".repeat(64)}`;
const pad = (value: number) => String(value).padStart(20, "0");
const captured = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../core/test/fixtures/modules/launchpad-contract/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
/** The captured pages' launch: launch b of the engine's curve fixture. */
const CAPTURED = captured("v1-opening-bidders.json").launch_id as string;

function blastInfra(reply: () => Response | Promise<Response>, seen: string[] = []): MarketDataDependencies {
  return {
    origin: ORIGIN,
    now: () => FIXTURE_TIMESTAMP_MS + 412,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: async (input: string | URL | Request) => {
      const path = String(input).slice(ORIGIN.length);
      if (path === "/v1/status") return Response.json({ provenance: infraProvenanceFixture() });
      seen.push(path);
      return reply();
    },
  };
}

const round = (overrides: Record<string, unknown> = {}) => ({
  duration_ms: "60000",
  starts_at_ms: "1790200000000",
  ends_at_ms: "1790200060000",
  total_committed_quote: "2500000000",
  bidder_count: 3,
  settlement: null,
  delivered_count: 0,
  undelivered_count: 3,
  state: "open",
  ...overrides,
});

test("an opening round parses exactly and its timing, counts and state must agree", () => {
  assert.deepEqual(parseOpeningRound(round(), "round"), {
    durationMs: 60_000n,
    startsAtMs: 1_790_200_000_000n,
    endsAtMs: 1_790_200_060_000n,
    totalCommittedQuote: 2_500_000_000n,
    bidderCount: 3,
    settlement: null,
    deliveredCount: 0,
    undeliveredCount: 3,
    state: "open",
  });
  const pending = parseOpeningRound(round({ starts_at_ms: null, ends_at_ms: null, state: "pending" }), "round");
  assert.deepEqual([pending.startsAtMs, pending.endsAtMs], [null, null]);
  const settlement = { checkpoint: 12, timestamp_ms: 1_790_200_090_000, digest: "9Xy3K7mQpR2sT4uV6wX8yZ1aB3cD5eF7gH9jK2mN4pQ" };
  assert.equal(parseOpeningRound(round({ settlement, state: "settled" }), "round").settlement?.checkpoint, 12);
  for (const [why, broken] of [
    ["end without a start", round({ starts_at_ms: null, state: "pending" })],
    ["end not start + duration", round({ ends_at_ms: "1790200060001" })],
    ["counts that do not add up", round({ delivered_count: 1 })],
    ["settled without a settlement", round({ state: "settled" })],
    ["a settlement not settled", round({ settlement, state: "open" })],
    ["pending once started", round({ state: "pending" })],
    ["a JSON number amount", round({ total_committed_quote: 2_500_000_000 })],
    ["an unknown state", round({ state: "closed" })],
  ] as const) {
    assert.throws(() => parseOpeningRound(broken, "round"), ContractViolation, why);
  }
});

test("window flow fields parse as a signed net and counts, for every named window", () => {
  const window = (net: string, buyers: number, sellers: number) => ({
    volume_quote: "1", volume_usd: null, buys: 1, sells: 0, trades: 1, net_quote_flow: net, buyers, sellers,
  });
  const flow = parseWindowFlow(
    { "5m": window("-5", 0, 1), "1h": window("10", 1, 1), "6h": window("10", 1, 1), "24h": window("10", 1, 1), all: window("10", 2, 1) },
    "windows",
  );
  assert.deepEqual(flow["5m"], { netQuoteFlow: -5n, buyers: 0, sellers: 1 });
  assert.deepEqual(flow.all, { netQuoteFlow: 10n, buyers: 2, sellers: 1 });
  assert.throws(() => parseWindowFlow({ "5m": window("-0", 0, 1) }, "windows"), ContractViolation);
  assert.throws(() => parseWindowFlow({ "5m": { ...window("1", 1, 0), buyers: "1" } }, "windows"), ContractViolation);
});

test("the engine's captured pool summary carries its round and flow fields", () => {
  const body = captured("v1-pool-opening.json");
  const pool = body.pool as Record<string, unknown>;
  const launch = parseLaunchSummary(pool);
  assert.equal(launch.openingRound?.state, "settled");
  assert.equal(launch.openingRound?.bidderCount, launch.openingRound!.deliveredCount + launch.openingRound!.undeliveredCount);
  const flow = parseWindowFlow(pool.windows, "pool.windows");
  assert.ok(flow.all.buyers >= 1, `all-time buyers ${flow.all.buyers}`);
});

test("the engine's captured bidders page parses in first-join order with its deliveries", () => {
  const page = parseBiddersPage(captured("v1-opening-bidders.json"));
  assert.ok(page.bidders.length >= 3);
  assert.equal(page.nextCursor, null);
  assert.ok(page.bidders.every((bidder) => bidder.contributedQuote > 0n && bidder.joinCount >= 1));
  assert.ok(page.bidders.every((bidder) => bidder.delivery !== null));
  const positions = page.bidders.map((bidder) => bidder.firstJoin.position.split(":").map(BigInt));
  positions.slice(1).forEach((position, index) => {
    const before = positions[index];
    const later = position.findIndex((part, at) => part !== before[at]);
    assert.ok(later >= 0 && position[later] > before[later], "first joins ascend");
  });
});

test("a bidders page out of order, repeated, or with a stray cursor is refused", () => {
  const body = captured("v1-opening-bidders.json");
  const rows = body.bidders as Record<string, unknown>[];
  assert.throws(() => parseBiddersPage({ ...body, bidders: [...rows].reverse() }), ContractViolation);
  assert.throws(() => parseBiddersPage({ ...body, bidders: [rows[0], rows[0]] }), ContractViolation);
  const stray = encodeCursor(biddersCursor(CAPTURED), [], [pad(1), pad(1), pad(0)]);
  assert.throws(() => parseBiddersPage({ ...body, next_cursor: stray }), ContractViolation);
  const first = rows[0].first_join as { position: string };
  const [checkpoint, tx, event] = first.position.split(":").map(Number);
  const last = encodeCursor(biddersCursor(CAPTURED), [], [pad(checkpoint), pad(tx), pad(event)]);
  const foreign = encodeCursor(biddersCursor(OTHER), [], [pad(checkpoint), pad(tx), pad(event)]);
  assert.throws(() => parseBiddersPage({ ...body, bidders: [rows[0]], next_cursor: foreign }), ContractViolation);
  assert.equal(parseBiddersPage({ ...body, bidders: [rows[0]], next_cursor: last }).nextCursor, last);
  assert.throws(
    () => parseBiddersPage({ ...body, bidders: [{ ...rows[0], contributed_quote: 5 }] }),
    ContractViolation,
  );
});

test("the engine's captured activity keeps settlement origin and is never a user buy", () => {
  const page = parseClassifiedActivityPage(CAPTURED, captured("v1-activity-classified.json"));
  const kinds = new Set(page.activity.map((row) => row.kind));
  for (const kind of ["opening_join", "opening_settlement", "opening_delivery", "curve_buy", "curve_sell", "lifecycle", "migration"]) {
    assert.ok(kinds.has(kind as never), kind);
  }
  const settlements = page.activity.filter((row) => row.kind === "opening_settlement");
  assert.ok(settlements.every((row) => row.source === "opening_round_settlement" && !countsAsUserTrade(row)));
  // Revision 4: joins and curve trades name their sender (a trade's executing signer), deliveries
  // their bidder; the settlement, lifecycle and migration rows name no one.
  for (const row of page.activity) {
    const named = ["opening_join", "curve_buy", "curve_sell", "opening_delivery"].includes(row.kind);
    assert.equal(row.actor !== null, named, `${row.kind} at ${row.position}`);
  }
  const users = page.activity.filter(countsAsUserTrade);
  assert.ok(users.length > 0 && users.every((row) => row.kind === "curve_buy" || row.kind === "curve_sell"));
});

test("a classified page keeps buys alongside direct and relayed vault reward claims", () => {
  const body = captured("v1-activity-classified.json");
  const buy = (body.activity as Record<string, unknown>[]).find((row) => row.kind === "curve_buy")!;
  const checkpoint = Number(buy.checkpoint) + 1;
  const claim = { ...buy, checkpoint, kind: "reward_claimed", amounts: { meme: "1", quote: "2" } };
  const paid = {
    ...claim, position: `${checkpoint}:1:3:0`, kind: "protocol_fees_paid", source: OTHER, actor: null,
    amounts: { meme: "1", quote: "2", sui: "0", partner_meme: "0", partner_quote: "0", partner_sui: "0" },
  };
  const allocation = { ...claim, position: `${checkpoint}:1:2:0`, kind: "migration_allocation", source: OTHER, actor: null };
  const relayed = { ...claim, position: `${checkpoint}:1:1:0`, source: OTHER };
  const page = parseClassifiedActivityPage(CAPTURED, {
    activity: [
      paid,
      allocation,
      relayed,
      { ...claim, position: `${checkpoint}:1:0:0`, source: null },
      buy,
    ],
    next_cursor: null,
  });
  assert.deepEqual(page.activity.map(({ kind, source }) => [kind, source]), [
    ["protocol_fees_claimed", OTHER],
    ["migration_allocation", OTHER],
    ["reward_claimed", OTHER],
    ["reward_claimed", null],
    ["curve_buy", buy.source],
  ]);
  assert.deepEqual(page.activity.filter(isActivityTrade).map(({ position }) => position), [buy.position]);
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { activity: [{ ...relayed, source: "user" }], next_cursor: null }),
    { message: "activity[0].source: is not a source of reward_claimed" });
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { activity: [{ ...relayed, source: [OTHER] }], next_cursor: null }),
    { message: "activity[0].source: is not a source of reward_claimed" });
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { activity: [{ ...allocation, source: null }], next_cursor: null }),
    { message: "activity[0].source: is not a source of migration_allocation" });
});

test("a new indexer activity kind keeps its position without hiding or becoming a trade", async () => {
  const body = captured("v1-activity-classified.json");
  const buy = (body.activity as Record<string, unknown>[]).find((row) => row.kind === "curve_buy")!;
  const checkpoint = Number(buy.checkpoint) - 1;
  const position = `${checkpoint}:1:2:0`;
  const future = { ...buy, kind: "future_vault_event", checkpoint, position, new_field: { version: 1 } };
  const next = encodeCursor(activityCursor(CAPTURED), [], [pad(checkpoint), pad(1), pad(2), pad(0)]);
  const response = { ...body, activity: [{ ...buy, labels: ["whale"] }, future], next_cursor: next, provenance: infraProvenanceFixture() };
  const read = await readClassifiedActivity(CAPTURED, {}, blastInfra(() => Response.json(response)));
  assert.equal(read.status, "fresh");
  assert.equal(read.data.kind, "answer");
  const page = read.data.value;
  assert.equal(page.nextCursor, next);
  assert.deepEqual(page.activity.filter(isActivityTrade).map(({ position, labels }) => [position, labels]), [[buy.position, ["whale"]]]);
  assert.deepEqual(page.activity[1], {
    kind: "unrecognized", position, checkpoint, timestampMs: buy.timestamp_ms, digest: buy.digest,
    actor: null, source: null, lifecycle: null, amounts: {},
  });
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { ...response, activity: [future, buy] }),
    { message: "activity[1]: is out of order" });
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { ...response, activity: [buy] }),
    { message: "next_cursor: must be the page's last place" });
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { ...response, activity: [buy, { ...future, kind: "" }] }),
    { message: "activity[1].kind: must be a non-empty string" });
});

test("a classified page that mislabels a row, reorders, or names a sender is refused", () => {
  const body = captured("v1-activity-classified.json");
  const rows = body.activity as Record<string, unknown>[];
  const settlement = rows.find((row) => row.kind === "opening_settlement")!;
  const delivery = rows.find((row) => row.kind === "opening_delivery")!;
  const buy = rows.find((row) => row.kind === "curve_buy")!;
  const join = rows.find((row) => row.kind === "opening_join")!;
  for (const [why, broken] of [
    ["settlement as a user buy", { ...settlement, kind: "curve_buy" }],
    ["settlement with a user source", { ...settlement, source: "user" }],
    ["a non-trade with wallet labels", { ...join, labels: ["sniper"] }],
    ["a trade with duplicate wallet labels", { ...buy, labels: ["whale", "whale"] }],
    ["an unrecognized label", { ...buy, labels: ["creator"] }],
    ["a buy without its signer", { ...buy, actor: null }],
    ["a join without its sender", { ...join, actor: null }],
    ["a settlement naming its sender", { ...settlement, actor: delivery.actor }],
    ["a delivery without its bidder", { ...delivery, actor: null }],
    ["a lifecycle row at sub 0", { ...buy, kind: "lifecycle", lifecycle: "live", source: null, amounts: {} }],
    ["a position off its checkpoint", { ...buy, checkpoint: Number(buy.checkpoint) + 1 }],
    ["an unrecognized kind without a position", { ...buy, kind: "future_vault_event", position: null }],
    ["a JSON number amount", { ...buy, amounts: { quote: 1, meme: "1" } }],
    ["an amount the kind has not", { ...buy, amounts: { quote: "1", meme: "1", bids: "1" } }],
  ] as const) {
    assert.throws(() => parseClassifiedActivityPage(CAPTURED, { ...body, activity: [broken] }), ContractViolation, why);
  }
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { ...body, activity: [...rows].reverse() }), ContractViolation);
  // A next cursor of another launch's list is refused.
  const [checkpoint, tx, event, sub] = (buy.position as string).split(":").map(Number);
  const foreign = encodeCursor(activityCursor(OTHER), [], [pad(checkpoint), pad(tx), pad(event), pad(sub)]);
  assert.throws(() => parseClassifiedActivityPage(CAPTURED, { ...body, activity: [buy], next_cursor: foreign }), ContractViolation);
});

test("request paths take bounded limits and only their own list's cursor", () => {
  const activity = encodeCursor(activityCursor(LAUNCH), [], [pad(12), pad(1), pad(3), pad(1)]);
  const bidders = encodeCursor(biddersCursor(LAUNCH), [], [pad(9), pad(1), pad(4)]);
  assert.equal(classifiedActivityPath(LAUNCH, {}), `/v1/launches/${LAUNCH}/activity?view=classified&limit=25`);
  assert.equal(
    classifiedActivityPath(LAUNCH, { limit: "100", cursor: activity }),
    `/v1/launches/${LAUNCH}/activity?view=classified&limit=100&cursor=${activity}`,
  );
  assert.equal(biddersPath(LAUNCH, { wallet: `0x${"5e".repeat(32)}` }), `/v1/launches/${LAUNCH}/opening-round/bidders?limit=25&wallet=0x${"5e".repeat(32)}`);
  for (const build of [
    () => classifiedActivityPath(LAUNCH, { limit: "0" }),
    () => classifiedActivityPath(LAUNCH, { limit: "101" }),
    () => classifiedActivityPath(LAUNCH, { cursor: bidders }),
    () => biddersPath(LAUNCH, { cursor: activity }),
    () => biddersPath(LAUNCH, { wallet: "0x1", cursor: bidders }),
    () => biddersPath("0x1", {}),
    // A token of another launch's list.
    () => classifiedActivityPath(OTHER, { cursor: activity }),
    () => biddersPath(OTHER, { cursor: bidders }),
  ]) {
    assert.throws(build, CursorError);
  }
});

test("opening and activity reads are fresh, stale under lag with the same rows, and unavailable on failure", async () => {
  const body = captured("v1-activity-classified.json");
  const seen: string[] = [];
  const fresh = await readClassifiedActivity(CAPTURED, {}, blastInfra(() => Response.json({ ...body, provenance: infraProvenanceFixture() }), seen));
  if (fresh.status !== "fresh" || fresh.data.kind !== "answer") return assert.fail(JSON.stringify(fresh));
  assert.deepEqual(seen, [`/v1/launches/${CAPTURED}/activity?view=classified&limit=25`]);
  const lagging = { ...body, provenance: infraProvenanceFixture({ observed_ms: FIXTURE_TIMESTAMP_MS + 45_000, lag_ms: 45_000 }) };
  const stale = await readClassifiedActivity(CAPTURED, {}, blastInfra(() => Response.json(lagging)));
  if (stale.status !== "stale" || stale.data.kind !== "answer") return assert.fail(JSON.stringify(stale));
  assert.deepEqual(stale.data.value.activity, fresh.data.value.activity);
  const failed = await readOpeningBidders(CAPTURED, {}, blastInfra(() => Promise.reject(new Error("down"))));
  assert.deepEqual({ status: failed.status, reason: failed.provenance.reason }, { status: "unavailable", reason: "unreachable" });
  const broken = await readOpeningBidders(
    CAPTURED,
    {},
    blastInfra(() => Response.json({ ...captured("v1-opening-bidders.json"), provenance: infraProvenanceFixture(), bidders: [{}] })),
  );
  assert.deepEqual({ status: broken.status, reason: broken.provenance.reason }, { status: "unavailable", reason: "contract-violation" });
});

test("a curve summary's flow is its own windows' flow, stamped by the summary's checkpoint", async () => {
  const body = captured("v1-pool-opening.json");
  const pool = body.pool as Record<string, unknown>;
  const launchId = pool.pool_id as string;
  const flow = parseCurveFlow(launchId, body);
  assert.deepEqual(flow.windows, parseWindowFlow(pool.windows, "pool.windows"));
  for (const [why, broken] of [
    ["another launch's curve", { ...body, pool: { ...pool, pool_key: `blast_curve:${OTHER}`, pool_id: OTHER } }],
    ["a venue pool", { ...body, pool: { ...pool, venue: "cetus" } }],
    ["windows without flow fields", { ...body, pool: { ...pool, windows: { ...(pool.windows as object), all: { volume_quote: "1", volume_usd: null, buys: 1, sells: 0, trades: 1 } } } }],
  ] as const) {
    assert.throws(() => parseCurveFlow(launchId, broken), ContractViolation, why);
  }
  const seen: string[] = [];
  const read = await readCurveFlow(launchId, blastInfra(() => Response.json({ ...body, provenance: infraProvenanceFixture() }), seen));
  if (read.status !== "fresh" || read.data.kind !== "answer") return assert.fail(JSON.stringify(read));
  assert.deepEqual(seen, [`/v1/pools/blast_curve/${launchId}`]);
  assert.equal(read.data.value.windows.all.buyers, flow.windows.all.buyers);
  assert.throws(() => readCurveFlow("0x1", blastInfra(() => Response.json({}), [])), CursorError);
});

test("an activity anchor starts a launch's page and a pool's tape at the anchored position, inclusive", () => {
  const anchor = activityAnchor(LAUNCH, "12:1:3:0");
  assert.equal(anchor.position, "12:1:3:0");
  // The page after the position just newer than it: the anchored row is its first.
  assert.deepEqual(decodeCursor(anchor.cursor, activityCursor(LAUNCH)).tie, [pad(12), pad(1), pad(3), pad(1)]);
  assert.equal(anchor.before, "12:1:3:1");
  assert.equal(classifiedActivityPath(LAUNCH, { cursor: anchor.cursor }), `/v1/launches/${LAUNCH}/activity?view=classified&limit=25&cursor=${anchor.cursor}`);
  // Exact beyond 2^53.
  assert.equal(activityAnchor(LAUNCH, "18446744073709551615:0:0:9007199254740993").before, "18446744073709551615:0:0:9007199254740994");
  for (const bad of ["12:1:3", "012:1:3:0", "12:1:3:x", "", "1:2:3:4:5"]) {
    assert.throws(() => activityAnchor(LAUNCH, bad), CursorError, bad);
  }
  assert.throws(() => activityAnchor("0x1", "12:1:3:0"), CursorError);
});
