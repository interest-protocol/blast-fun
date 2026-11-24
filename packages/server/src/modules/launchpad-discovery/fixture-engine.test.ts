import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_TIMESTAMP_MS } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { discoveryFixtureEngine, type FixtureEngineState } from "../../../test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import type { DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";

const id = (byte: string) => `0x${byte.repeat(32)}`;

function engine(state: FixtureEngineState = "serving") {
  return discoveryFixtureEngine({ state: () => state, now: () => FIXTURE_TIMESTAMP_MS });
}

async function page(query: string, state: FixtureEngineState = "serving") {
  const response = await handleDiscoveryRequest(new Request(`https://blast.test/api/launchpad/discovery?${query}`), engine(state));
  return { status: response.status, body: (await response.json()) as DiscoveryResponse };
}

/** Every page of a view at `limit`, following the opaque cursors. */
async function walk(view: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const { body } = await page(`view=${view}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(body.section.state, "available");
    if (body.section.state !== "available") break;
    ids.push(...body.section.data.rows.map((row: DiscoveryRow) => row.launchId));
    cursor = body.section.data.nextCursor;
    pages += 1;
  } while (cursor);
  return { ids, pages };
}

// The fixture snapshot: 26 launches and unrelated Cetus and Bluefin pools. Expected orders are
// worked by hand from the view rules (docs/api.md, "Discovery views"), not by the engine's code.
// 0c–12 were created in one checkpoint (103), 13–1a in another (97) and graduated together (125).
const NEW = [
  "12", "11", "10", "0f", "0e", "0d", "0c", "0a", "06", "05", // 05 | 04 share checkpoint 101
  "04", "03", "02", "01", "08", "07", "09", "0b", "1a", "19", // 19 | 18 share checkpoint 97
  "18", "17", "16", "15", "14", "13",
].map(id);
// 03 has nothing left; 01, 02, 0a and 0c–12 have the same 5 SUI left, oldest first.
const NEAR_GRADUATION = ["03", "01", "02", "0a", "0c", "0d", "0e", "0f", "10", "11", "12", "05"].map(id);
// 13–1a graduated at checkpoint 125; 08, 07 and 0b at 120, newest position first.
const GRADUATED = ["1a", "19", "18", "17", "16", "15", "14", "13", "08", "07", "0b", "09"].map(id);

test("each view lists only its eligible Blast launches in its exact order", async () => {
  assert.deepEqual((await walk("new", 100)).ids, NEW);
  assert.deepEqual((await walk("near_graduation", 100)).ids, NEAR_GRADUATION);
  assert.deepEqual((await walk("graduated", 100)).ids, GRADUATED);
});

test("pages split inside equal creation times, equal Quote remaining and equal migration times without a repeat or a gap", async () => {
  for (const limit of [1, 2, 3, 10]) {
    const fresh = await walk("new", limit);
    assert.deepEqual(fresh.ids, NEW, `new at ${limit}`);
    assert.equal(fresh.pages, Math.ceil(NEW.length / limit));
    assert.deepEqual((await walk("near_graduation", limit)).ids, NEAR_GRADUATION, `near_graduation at ${limit}`);
    assert.deepEqual((await walk("graduated", limit)).ids, GRADUATED, `graduated at ${limit}`);
  }
});

test("unrelated Sui pools, opening-round launches and launches without progress never reach a view", async () => {
  const all = new Set([...(await walk("new", 100)).ids, ...(await walk("near_graduation", 100)).ids, ...(await walk("graduated", 100)).ids]);
  assert.equal(all.size, 26);
  for (const unrelated of ["c1", "b1"].map(id)) assert.equal(all.has(unrelated), false);
  const near = (await walk("near_graduation", 100)).ids;
  assert.equal(near.includes(id("04")), false, "opening round");
  assert.equal(near.includes(id("06")), false, "graduation target 0");
});

test("duplicate names and tickers stay distinct launches, and a missing fact stays null", async () => {
  const { body } = await page("view=new&limit=100");
  assert.equal(body.section.state, "available");
  if (body.section.state !== "available") return;
  const frogs = body.section.data.rows.filter((row) => row.symbol === "FROG");
  assert.deepEqual(frogs.map((row) => row.launchId), ["02", "01", "07"].map(id));
  assert.equal(body.section.data.rows.filter((row) => row.symbol === "TOAD").length, 2);
  assert.equal(new Set(frogs.map((row) => row.coinType)).size, 3);
  const bare = body.section.data.rows.find((row) => row.launchId === id("05"));
  assert.deepEqual([bare?.name, bare?.symbol, bare?.iconUrl], [null, null, null]);
  const noTarget = body.section.data.rows.find((row) => row.launchId === id("06"));
  assert.deepEqual([noTarget?.quoteRemaining, noTarget?.progressBps], [null, null]);
});

test("a fresh deployment with no launches serves every view Empty", async () => {
  for (const view of ["new", "near_graduation", "graduated"]) {
    const { status, body } = await page(`view=${view}`, "empty");
    assert.equal(status, 200);
    assert.equal(body.section.state, "empty", view);
  }
});

test("the engine's outages reach the view as Stale or Unavailable", async () => {
  const lagging = await page("view=new", "lagging");
  assert.equal(lagging.body.section.state, "stale");
  const halted = await page("view=new", "halted");
  assert.equal(halted.body.section.state, "stale");
  for (const state of ["starting", "unreachable"] as const) {
    const down = await page("view=new", state);
    assert.equal(down.status, 503, state);
    assert.equal(down.body.section.state, "unavailable", state);
  }
});
