import assert from "node:assert/strict";
import test from "node:test";

import { COIN_FIXTURE, errorBody } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import {
  FIXTURE_HOLDERS,
  HOLDER_BEHIND_CHECKPOINT,
  HOLDER_FIXTURE_CHECKPOINT,
  holderSnapshotBody,
  type HolderFixtureState,
} from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/holder-fixtures.ts";
import { sameOriginFetch, testMarketRoutes } from "../../../../test/fixtures/modules/launchpad-market/testing.ts";
import { browserMarketDependencies } from "../blast-infra-browser.ts";
import { readHoldersPage, type HoldersSource } from "./holders-client.ts";
import {
  INITIAL_HOLDERS,
  afterMore,
  afterRefresh,
  holdersDisplay,
  showNewer,
  type HoldersOutcome,
  type HoldersState,
} from "./holders-model.ts";

const ORIGIN = "https://api.blast.test";
const NOW = 1_790_235_061_630;
const SOURCE: HoldersSource = {
  launchId: COIN_FIXTURE.launchId,
  coinType: COIN_FIXTURE.coinType,
  expected: null,
  symbol: "FROGGY",
  decimals: 6,
};

type Reply = Readonly<{ status: number; body: unknown }> | "unreachable";

/** blast-infra behind the app's market routes: every request that reaches it is recorded, then answered by `reply`. */
function engine(reply: (url: URL) => Reply) {
  const seen: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/status") return Response.json({ provenance: holderSnapshotBody("zero", {}, NOW).provenance });
    seen.push(`${url.pathname}${url.search}`);
    const answer = reply(url);
    if (answer === "unreachable") throw new TypeError("Failed to fetch");
    return Response.json(answer.body, { status: answer.status });
  };
  const routes = testMarketRoutes(ORIGIN, { apiKey: null, fetch: fetcher as typeof fetch });
  return { seen, dependencies: browserMarketDependencies(null, sameOriginFetch(routes), () => NOW) };
}

/** The engine holding `state`, paged as it would be. */
function holding(state: HolderFixtureState, lagMs?: number) {
  return engine((url) => ({
    status: 200,
    body: holderSnapshotBody(state, { cursor: url.searchParams.get("cursor"), limit: Number(url.searchParams.get("limit")) }, NOW, lagMs),
  }));
}

async function read(dependencies: ReturnType<typeof engine>["dependencies"], cursor: string | null = null): Promise<HoldersOutcome> {
  return readHoldersPage(SOURCE, cursor, dependencies);
}

async function refreshed(state: HoldersState, dependencies: ReturnType<typeof engine>["dependencies"]) {
  return afterRefresh(state, await read(dependencies));
}

function facts(state: HoldersState) {
  const display = holdersDisplay(state);
  assert.equal(display.kind, "facts", `expected facts, got ${JSON.stringify(display.kind)}`);
  return display as Extract<ReturnType<typeof holdersDisplay>, { kind: "facts" }>;
}

test("the browser reads the snapshot page from the app's same-origin route, calling fetch unbound", async () => {
  const calls: { self: unknown; url: string }[] = [];
  const fetcher = function (this: unknown, input: string | URL | Request) {
    calls.push({ self: this, url: String(input) });
    return Promise.resolve(Response.json(holderSnapshotBody("complete", {}, NOW)));
  };
  const outcome = await readHoldersPage(SOURCE, null, browserMarketDependencies(null, fetcher as typeof fetch, () => NOW));
  assert.equal(outcome.kind, "facts");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, undefined, "a browser's fetch throws when called on another object");
  assert.equal(calls[0].url, `/api/launchpad/market/coins/${COIN_FIXTURE.coinType}/holders?view=snapshot&limit=25`);
});

test("a complete snapshot shows its count and named concentration from one checkpoint, never from the loaded rows", async () => {
  const { dependencies } = holding("complete");
  const display = facts(await refreshed(INITIAL_HOLDERS, dependencies));
  const held = FIXTURE_HOLDERS.reduce((sum, holder) => sum + holder.balance, 0n);
  assert.equal(display.stale, null);
  assert.equal(display.view.snapshot.state, "complete");
  assert.equal(display.view.snapshot.checkpoint, HOLDER_FIXTURE_CHECKPOINT);
  assert.equal(display.view.provenance.checkpoint, HOLDER_FIXTURE_CHECKPOINT);
  assert.equal(display.view.totals.holderCount, 30n, "every holder, though one page of 25 is loaded");
  assert.equal(display.view.totals.heldSupply, held, "the denominator is the whole held supply");
  assert.deepEqual(display.view.totals.top1, { amount: 120_000_000_000n, shareBps: (120_000_000_000n * 10_000n) / held });
  assert.equal(display.view.rows.length, 25);
  assert.equal(display.view.rows[0].address, COIN_FIXTURE.creator);
  assert.ok(display.view.nextCursor);
});

test("an incomplete snapshot is never a zero: no count, and a later incomplete answer withdraws earlier facts", async () => {
  const incomplete = await refreshed(INITIAL_HOLDERS, holding("incomplete").dependencies);
  const display = holdersDisplay(incomplete);
  assert.equal(display.kind, "incomplete");
  assert.equal(display.kind === "incomplete" && display.snapshot.checkpoint, HOLDER_FIXTURE_CHECKPOINT);
  assert.ok(!("view" in display), "no facts at all");

  const complete = await refreshed(INITIAL_HOLDERS, holding("complete").dependencies);
  assert.equal(holdersDisplay(await refreshed(complete, holding("incomplete").dependencies)).kind, "incomplete");
});

test("a genuine zero is a complete snapshot with no holders, distinct from incomplete", async () => {
  const display = facts(await refreshed(INITIAL_HOLDERS, holding("zero").dependencies));
  assert.equal(display.view.snapshot.state, "complete");
  assert.equal(display.view.totals.holderCount, 0n);
  assert.equal(display.view.totals.top1.shareBps, null);
  assert.deepEqual(display.view.rows, []);
});

test("a snapshot behind the committed checkpoint, or a lagging engine, shows its facts as Stale with the cause", async () => {
  const behind = facts(await refreshed(INITIAL_HOLDERS, holding("behind").dependencies));
  assert.equal(behind.view.snapshot.checkpoint, HOLDER_BEHIND_CHECKPOINT);
  assert.deepEqual(behind.stale, { cause: "behind" });

  const lagging = facts(await refreshed(INITIAL_HOLDERS, holding("complete", 45_000).dependencies));
  assert.deepEqual(lagging.stale, { cause: "lagging" });
  assert.equal(lagging.view.provenance.lagMs, 45_000);
});

test("an outage keeps the last successful facts as Stale with their provenance; without any it is Unavailable", async () => {
  const outages: [string, Reply][] = [
    ["unreachable", "unreachable"],
    ["unavailable", { status: 503, body: errorBody("not_ready", "the engine has not bootstrapped") }],
    ["contract-violation", { status: 200, body: { ...holderSnapshotBody("complete", {}, NOW), holder_count: "0" } }],
  ];
  const complete = await refreshed(INITIAL_HOLDERS, holding("complete").dependencies);
  for (const [reason, reply] of outages) {
    const down = engine(() => reply).dependencies;
    const kept = facts(await refreshed(complete, down));
    assert.deepEqual(kept.stale, { cause: "failed", reason }, reason);
    assert.equal(kept.view, facts(complete).view, `${reason}: the same verified facts and provenance`);
    assert.deepEqual(holdersDisplay(await refreshed(INITIAL_HOLDERS, down)), { kind: "unavailable", reason }, reason);
  }
  const refused = engine(() => ({ status: 404, body: errorBody("not_found", "no such coin") })).dependencies;
  assert.deepEqual(holdersDisplay(await refreshed(INITIAL_HOLDERS, refused)), { kind: "unavailable", reason: "not_found" });
});

test("loading more appends the next rows once each; totals and their checkpoint stay the first page's", async () => {
  const { dependencies, seen } = holding("complete");
  const first = await refreshed(INITIAL_HOLDERS, dependencies);
  const cursor = facts(first).view.nextCursor as string;
  const more = afterMore(first, cursor, await read(dependencies, cursor));
  const view = facts(more).view;
  assert.equal(seen.at(-1), `/v1/coins/${COIN_FIXTURE.coinType}/holders?view=snapshot&limit=25&cursor=${cursor}`);
  assert.deepEqual(view.rows.map((row) => row.address), FIXTURE_HOLDERS.map((holder) => holder.address));
  assert.equal(view.nextCursor, null);
  assert.equal(view.pages, 2);
  assert.equal(view.totals, facts(first).view.totals);

  // A page that repeats an address already shown (its balance moved) adds it once.
  const repeat = facts(afterMore(first, cursor, await read(dependencies))).view;
  assert.equal(repeat.rows.length, 25);
  assert.equal(new Set(repeat.rows.map((row) => row.address)).size, 25);

  // An answer for a cursor the view no longer holds is dropped.
  assert.equal(afterMore(INITIAL_HOLDERS, cursor, await read(dependencies, cursor)), INITIAL_HOLDERS);
  // A failed page keeps the rows and says why.
  const failed = afterMore(first, cursor, { kind: "failed", reason: "unreachable" });
  assert.equal(facts(failed).view, facts(first).view);
  assert.equal(failed.moreFailed, "unreachable");
});

test("a refresh while several pages are shown offers the newer snapshot instead of replacing the rows", async () => {
  const { dependencies } = holding("complete");
  const first = await refreshed(INITIAL_HOLDERS, dependencies);
  const cursor = facts(first).view.nextCursor as string;
  const paged = afterMore(first, cursor, await read(dependencies, cursor));
  const same = await refreshed(paged, dependencies);
  assert.equal(same.newer, null, "a snapshot at the shown checkpoint is nothing newer");
  const later = await read(dependencies);
  assert.equal(later.kind, "facts");
  const offered = afterRefresh(paged, later.kind === "facts" ? { ...later, snapshot: { ...later.snapshot, checkpoint: HOLDER_FIXTURE_CHECKPOINT + 6 } } : later);
  assert.equal(facts(offered).view, facts(paged).view, "the rows stay");
  assert.equal(offered.newer?.snapshot.checkpoint, HOLDER_FIXTURE_CHECKPOINT + 6, "the newer snapshot is offered");
  const shown = showNewer(offered);
  assert.equal(facts(shown).view.pages, 1);
  assert.equal(shown.newer, null);
  // With one page, a refresh replaces it.
  assert.notEqual(facts(await refreshed(first, dependencies)).view, facts(first).view);
});
