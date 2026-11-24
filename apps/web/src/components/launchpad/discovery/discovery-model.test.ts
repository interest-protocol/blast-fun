import assert from "node:assert/strict";
import test from "node:test";

import { provenanceFixture } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import type { DiscoveryPageData, DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import {
  afterFirstPage,
  afterNextPage,
  discoveryPageUrl,
  railDisplayState,
  formatQuoteAmount,
  formatUtc,
  orderFact,
} from "./discovery-model.ts";

const id = (byte: string) => `0x${byte.repeat(32)}`;

function row(byte: string, overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    launchId: id(byte),
    coinType: `0x${byte.repeat(31)}ff::meme::MEME`,
    quoteType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    lifecycle: "live",
    name: "Froggy",
    symbol: "FROG",
    iconUrl: null,
    createdAtMs: 1_790_231_561_218,
    graduatedAtMs: null,
    quoteRemaining: "5000000000",
    quoteDecimals: 9,
    progressBps: 8333,
    partner: null,
    ...overrides,
  };
}

function available(rows: DiscoveryRow[], nextCursor: string | null = null, provenance = provenanceFixture()): DiscoveryResponse {
  return { view: "new", section: { state: "available", data: { rows, nextCursor }, provenance } };
}

const down: DiscoveryResponse = { view: "new", section: { state: "unavailable", reason: "not_ready", retryAfterSeconds: 5 } };

test("a first page becomes the view's facts with readable provenance", () => {
  const state = afterFirstPage({ status: "loading" }, available([row("01")], "next-1"));
  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;
  assert.deepEqual(state.value, { rows: [row("01")], nextCursor: "next-1" });
  assert.deepEqual(state.provenance, {
    network: "mainnet",
    deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
    checkpoint: "326274009",
    observedAt: "2026-09-24T07:31:01.630Z",
    lagMs: 412,
  });
});

test("an outage before any facts is Unavailable with a readable reason; after facts it keeps them as Stale", () => {
  assert.deepEqual(afterFirstPage({ status: "loading" }, down), { status: "unavailable", reason: "the indexer is starting" });
  assert.deepEqual(afterFirstPage({ status: "loading" }, null), { status: "unavailable", reason: "the request did not complete" });
  const shown = afterFirstPage({ status: "loading" }, available([row("01")]));
  const refreshed = afterFirstPage(shown, down);
  assert.equal(refreshed.status, "stale");
  if (refreshed.status !== "stale" || shown.status !== "ready") return;
  assert.deepEqual(refreshed.value, shown.value);
  assert.deepEqual(refreshed.provenance, shown.provenance);
  assert.equal(refreshed.reason, "Refresh failed: the indexer is starting");
});

test("a lagging page is Stale with the indexer's own lag", () => {
  const lagging = provenanceFixture({ lagMs: 45_000, reason: "lagging" });
  const state = afterFirstPage({ status: "loading" }, {
    view: "new",
    section: { state: "stale", data: { rows: [row("01")], nextCursor: null }, provenance: lagging, reason: "lagging" },
  });
  assert.equal(state.status, "stale");
  if (state.status !== "stale") return;
  assert.equal(state.reason, "The indexer is behind the chain");
  assert.equal(state.provenance.lagMs, 45_000);
});

test("an empty current view is Empty, not a list of zero rows", () => {
  const state = afterFirstPage({ status: "loading" }, { view: "new", section: { state: "empty", provenance: provenanceFixture() } });
  assert.equal(state.status, "empty");
});

test("the next page appends after the last row, never repeating a launch already listed", () => {
  const first = afterFirstPage({ status: "loading" }, available([row("01"), row("02")], "next-1"));
  const second = afterNextPage(first, available([row("02"), row("03")], "next-2"));
  assert.equal(second.status, "ready");
  if (second.status !== "ready") return;
  assert.deepEqual(second.value.rows.map((item) => item.launchId), [id("01"), id("02"), id("03")]);
  assert.equal(second.value.nextCursor, "next-2");
  const last = afterNextPage(second, { view: "new", section: { state: "empty", provenance: provenanceFixture() } });
  assert.equal(last.status, "ready");
  if (last.status !== "ready") return;
  assert.equal(last.value.rows.length, 3);
  assert.equal(last.value.nextCursor, null);
});

test("a failed next page keeps the listed rows Stale and the cursor to retry", () => {
  const first = afterFirstPage({ status: "loading" }, available([row("01")], "next-1"));
  const failed = afterNextPage(first, down);
  assert.equal(failed.status, "stale");
  if (failed.status !== "stale") return;
  assert.deepEqual(failed.value, { rows: [row("01")], nextCursor: "next-1" } satisfies DiscoveryPageData);
  assert.equal(failed.reason, "More launches could not be loaded: the indexer is starting");
});

test("amounts are exact decimals of atomic units; unknown decimals never guess a scale", () => {
  assert.equal(formatQuoteAmount("25111417257", 9), "25.111417257");
  assert.equal(formatQuoteAmount("1234500000000", 9), "1,234.5");
  assert.equal(formatQuoteAmount("0", 9), "0");
  assert.equal(formatQuoteAmount("7", 9), "0.000000007");
  assert.equal(formatQuoteAmount("25111417257", null), "—");
  assert.equal(formatUtc(1_790_235_061_218), "2026-09-24 07:31:01 UTC");
});

test("each row states the fact its view orders by", () => {
  const live = row("01", { createdAtMs: 1_790_235_061_218 });
  assert.equal(orderFact("new", live), "Created 2026-09-24 07:31:01 UTC");
  assert.equal(orderFact("near_graduation", live), "5 SUI to graduate · 83.33%");
  assert.equal(orderFact("near_graduation", row("02", { quoteRemaining: null, progressBps: null })), "Progress unavailable");
  assert.equal(orderFact("graduated", row("03", { lifecycle: "migrated", graduatedAtMs: 1_790_235_061_218 })), "Graduated 2026-09-24 07:31:01 UTC");
});

test("the rail reads ten launches a page and follows the served cursor", () => {
  assert.equal(discoveryPageUrl("near_graduation", null), "/api/launchpad/discovery?catalog=bonding&sort=progress&q=&limit=10");
  assert.equal(discoveryPageUrl("near_graduation", "eyJ2Ijox"), "/api/launchpad/discovery?catalog=bonding&sort=progress&q=&limit=10&cursor=eyJ2Ijox");
  assert.equal(discoveryPageUrl("new", "eyJ2Ijox"), "/api/launchpad/discovery?view=new&limit=10&cursor=eyJ2Ijox");
});

test("loaded rows turn Stale once they are more than a minute old, without losing them", () => {
  const shown = afterFirstPage({ status: "loading" }, available([row("01")]));
  const observed = Date.parse("2026-09-24T07:31:01.630Z");
  assert.equal(railDisplayState(shown, observed + 60_000).status, "ready");
  const aged = railDisplayState(shown, observed + 61_000);
  assert.equal(aged.status, "stale");
  if (aged.status !== "stale" || shown.status !== "ready") return;
  assert.deepEqual(aged.value, shown.value);
  assert.equal(aged.reason, "Not refreshed for more than 1 min");
  // Before the browser clock runs (the server render), nothing is aged.
  assert.equal(railDisplayState(shown, 0).status, "ready");
});
