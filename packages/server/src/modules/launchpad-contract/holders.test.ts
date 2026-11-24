import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { activityCursor, parseBiddersPage, parseClassifiedActivityPage } from "@blast/core/modules/launchpad-contract/activity.ts";
import { CursorError, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { DISCOVERY_VIEWS, parseDiscoveryPage } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { FIXTURE_TIMESTAMP_MS, infraProvenanceFixture } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { holdersCursor, holdersSnapshotPath, parseHoldersSnapshotPage, readHoldersSnapshot } from "@blast/core/modules/launchpad-contract/holders.ts";

const ORIGIN = "https://api.blast.test";
const OTHER = `0x${"7".repeat(64)}`;
const pad = (value: bigint | number | string) => String(value).padStart(20, "0");
const captured = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../core/test/fixtures/modules/launchpad-contract/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * The captures are blast-infra's curve fixture at `lst/T-027-1`: coin a at the last checkpoint
 * (a page of 2 of its 6 holders), and coin b at the launch of its opening round, which no address
 * holds yet. The launches are the fixture manifest's.
 */
const COIN_A = captured("v1-holders-snapshot.json").coin as string;
const LAUNCH_A = "0x26f6bc569182e7ab9db81fab58a06e784e7e0d23dc1675fef444f4bf8ff75fb8";
const COIN_B = captured("v1-holders-snapshot-zero.json").coin as string;
const LAUNCH_B = captured("v1-opening-bidders.json").launch_id as string;

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

/** The engine's incomplete answer for coin a: its snapshot, and no fact at all. */
function incomplete(): Record<string, unknown> {
  const body = captured("v1-holders-snapshot.json");
  return {
    ...body,
    snapshot: { ...(body.snapshot as object), state: "incomplete" },
    holder_count: null,
    held_supply: null,
    top_1: null,
    top_10: null,
    holders: null,
    next_cursor: null,
  };
}

test("a complete capture parses exactly, its shares of the held supply and its next cursor bound to the launch", () => {
  const page = parseHoldersSnapshotPage(LAUNCH_A, COIN_A, captured("v1-holders-snapshot.json"));
  assert.deepEqual(page.snapshot, { state: "complete", checkpoint: 124, timestampMs: 1_790_294_757_750 });
  const facts = page.facts!;
  assert.deepEqual(
    [facts.holderCount, facts.heldSupply, facts.top1, facts.top10],
    [
      6n,
      597_694_095_590_364_137n,
      { amount: 175_872_616_585_214_455n, shareBps: 2942n },
      { amount: 597_694_095_590_364_137n, shareBps: 10_000n },
    ],
  );
  assert.deepEqual(
    facts.holders.map((row) => [row.balance, row.shareBps]),
    [
      [175_872_616_585_214_455n, 2942n],
      [129_745_835_606_790_027n, 2170n],
    ],
  );
  // The token is the web envelope: no key, the last row's padded balance and address.
  const last = facts.holders[1];
  assert.equal(facts.nextCursor, encodeCursor(holdersCursor(LAUNCH_A), [], [pad(last.balance), last.address]));
});

test("a genuine zero is complete with no holders and no shares; behind serves every fact", () => {
  const zero = parseHoldersSnapshotPage(LAUNCH_B, COIN_B, captured("v1-holders-snapshot-zero.json"));
  assert.equal(zero.snapshot.state, "complete");
  assert.deepEqual(zero.facts, {
    holderCount: 0n,
    heldSupply: 0n,
    top1: { amount: 0n, shareBps: null },
    top10: { amount: 0n, shareBps: null },
    holders: [],
    nextCursor: null,
  });
  const body = captured("v1-holders-snapshot.json");
  const behind = parseHoldersSnapshotPage(LAUNCH_A, COIN_A, { ...body, snapshot: { ...(body.snapshot as object), state: "behind" } });
  assert.equal(behind.snapshot.state, "behind");
  assert.deepEqual(behind.facts, parseHoldersSnapshotPage(LAUNCH_A, COIN_A, body).facts);
});

test("an incomplete snapshot carries no fact; a partial or zeroed one is refused, never read as zero", () => {
  const page = parseHoldersSnapshotPage(LAUNCH_A, COIN_A, incomplete());
  assert.deepEqual(page, { coin: COIN_A, snapshot: { state: "incomplete", checkpoint: 124, timestampMs: 1_790_294_757_750 }, facts: null });
  const zero = captured("v1-holders-snapshot-zero.json");
  for (const field of ["holder_count", "held_supply", "top_1", "top_10", "holders", "next_cursor"]) {
    const value = field === "next_cursor" ? captured("v1-holders-snapshot.json").next_cursor : zero[field];
    assert.throws(() => parseHoldersSnapshotPage(LAUNCH_A, COIN_A, { ...incomplete(), [field]: value }), ContractViolation, field);
  }
  for (const field of ["holder_count", "held_supply", "top_1", "top_10", "holders"]) {
    assert.throws(
      () => parseHoldersSnapshotPage(LAUNCH_A, COIN_A, { ...captured("v1-holders-snapshot.json"), [field]: null }),
      ContractViolation,
      `complete without ${field}`,
    );
  }
});

test("a snapshot of another coin, with a broken share, order or count, or another launch's cursor is refused", () => {
  const body = captured("v1-holders-snapshot.json");
  const rows = body.holders as Record<string, unknown>[];
  const top1 = body.top_1 as Record<string, unknown>;
  for (const [why, broken] of [
    ["another coin", { ...body, coin: COIN_B }],
    ["an unknown state", { ...body, snapshot: { ...(body.snapshot as object), state: "stale" } }],
    ["a JSON number count", { ...body, holder_count: 6 }],
    ["a share of the live supply", { ...body, top_1: { ...top1, share_bps: "2941" } }],
    ["a row share off the formula", { ...body, holders: [{ ...rows[0], share_bps: "2943" }, rows[1]] }],
    ["rows out of order", { ...body, holders: [rows[1], rows[0]] }],
    ["a row repeated", { ...body, holders: [rows[0], rows[0]] }],
    ["0x0 as a holder", { ...body, holders: [{ ...rows[0], address: `0x${"0".repeat(64)}` }], next_cursor: null }],
    ["a top 1 below a row", { ...body, top_1: { amount: "1", share_bps: "0" } }],
    ["a top 10 short of a small coin's held supply", { ...body, top_10: { ...top1 } }],
    ["more rows than holders", { ...body, holder_count: "1" }],
    ["a next cursor off the last row", { ...body, holders: [rows[0]] }],
    ["an unknown field", { ...body, live_supply: "1" }],
  ] as const) {
    assert.throws(() => parseHoldersSnapshotPage(LAUNCH_A, COIN_A, broken), ContractViolation, why);
  }
  // The same page requested through another launch: its next cursor is that launch's list's, not this one's.
  assert.throws(() => parseHoldersSnapshotPage(OTHER, COIN_A, body), ContractViolation);
  const foreign = encodeCursor(holdersCursor(OTHER), [], [pad(rows[1].balance as string), rows[1].address as string]);
  assert.throws(() => parseHoldersSnapshotPage(LAUNCH_A, COIN_A, { ...body, next_cursor: foreign }), ContractViolation);
});

test("the request path takes a bounded limit and only this launch's holder cursor", () => {
  const token = captured("v1-holders-snapshot.json").next_cursor as string;
  assert.equal(holdersSnapshotPath(COIN_A, LAUNCH_A, {}), `/v1/coins/${COIN_A}/holders?view=snapshot&limit=25`);
  assert.equal(
    holdersSnapshotPath(COIN_A, LAUNCH_A, { limit: "100", cursor: token }),
    `/v1/coins/${COIN_A}/holders?view=snapshot&limit=100&cursor=${token}`,
  );
  const activity = encodeCursor(activityCursor(LAUNCH_A), [], [pad(1), pad(1), pad(1), pad(0)]);
  for (const build of [
    () => holdersSnapshotPath(COIN_A, LAUNCH_A, { limit: "0" }),
    () => holdersSnapshotPath(COIN_A, LAUNCH_A, { limit: "101" }),
    () => holdersSnapshotPath(COIN_A, LAUNCH_A, { cursor: activity }),
    () => holdersSnapshotPath(COIN_A, OTHER, { cursor: token }),
    () => holdersSnapshotPath("nope", LAUNCH_A, {}),
    () => holdersSnapshotPath(COIN_A, "0x1", {}),
  ]) {
    assert.throws(build, CursorError);
  }
});

test("holder snapshot reads are fresh, refused as blast-infra answers, and unavailable on a broken body", async () => {
  const body = captured("v1-holders-snapshot.json");
  const seen: string[] = [];
  const fresh = await readHoldersSnapshot(COIN_A, LAUNCH_A, { limit: "2" }, blastInfra(() => Response.json({ ...body, provenance: infraProvenanceFixture() }), seen));
  if (fresh.status !== "fresh" || fresh.data.kind !== "answer") return assert.fail(JSON.stringify(fresh, (_, value) => (typeof value === "bigint" ? `${value}` : value)));
  assert.deepEqual(seen, [`/v1/coins/${COIN_A}/holders?view=snapshot&limit=2`]);
  assert.equal(fresh.data.value.facts?.holders.length, 2);
  const missing = await readHoldersSnapshot(
    COIN_A,
    LAUNCH_A,
    {},
    blastInfra(() => Response.json({ error: { code: "not_found", message: "no launched coin" } }, { status: 404 })),
  );
  if (missing.status === "unavailable" || missing.data.kind !== "refused") return assert.fail("a 404 is blast-infra's refusal");
  assert.equal(missing.data.error.code, "not_found");
  const broken = await readHoldersSnapshot(COIN_A, LAUNCH_A, {}, blastInfra(() => Response.json({ ...incomplete(), holder_count: "0", provenance: infraProvenanceFixture() })));
  assert.deepEqual({ status: broken.status, reason: broken.provenance.reason }, { status: "unavailable", reason: "contract-violation" });
});

/** Every key and string value of a parsed DTO, bigints included. */
function words(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(words);
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, inner]) => [key, ...words(inner)]);
  return typeof value === "string" ? [value] : [];
}

test("no launchpad DTO admits blast-infra's creator, whale or top_trader labels", () => {
  const LABELS = ["creator", "whale", "top_trader"];
  const labelled = (rows: unknown) => (rows as Record<string, unknown>[]).map((row) => ({ ...row, labels: LABELS }));
  const admitted = (parse: () => unknown, why: string) => {
    let parsed: unknown;
    try {
      parsed = parse();
    } catch (error) {
      if (error instanceof ContractViolation) return;
      throw error;
    }
    const carried = words(parsed);
    assert.ok(!carried.includes("labels") && !LABELS.some((label) => carried.includes(label)), why);
  };
  for (const view of DISCOVERY_VIEWS) {
    const body = captured(`v1-discovery-${view}.json`);
    admitted(() => parseDiscoveryPage(view, { ...body, pools: labelled(body.pools) }), `discovery ${view}`);
  }
  const bidders = captured("v1-opening-bidders.json");
  admitted(() => parseBiddersPage({ ...bidders, bidders: labelled(bidders.bidders) }), "bidders");
  const activity = captured("v1-activity-classified.json");
  admitted(() => parseClassifiedActivityPage(LAUNCH_B, { ...activity, activity: labelled(activity.activity) }), "activity");
  const holders = captured("v1-holders-snapshot.json");
  assert.throws(() => parseHoldersSnapshotPage(LAUNCH_A, COIN_A, { ...holders, holders: labelled(holders.holders) }), ContractViolation);
  assert.throws(() => parseHoldersSnapshotPage(LAUNCH_A, COIN_A, { ...holders, labels: LABELS }), ContractViolation);
});
