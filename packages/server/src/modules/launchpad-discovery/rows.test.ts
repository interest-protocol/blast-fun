import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_TIMESTAMP_MS } from "../../../test/fixtures/modules/launchpad-contract/fixtures.ts";
import { discoveryFixtureEngine } from "../../../test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import type { VerifiedReader } from "@blast/server/modules/launchpad-discovery/verified.ts";
import { parseDiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";

async function served(query: string, state: "serving" | "starting" = "serving"): Promise<unknown> {
  const engine = discoveryFixtureEngine({ state: () => state, now: () => FIXTURE_TIMESTAMP_MS });
  const response = await handleDiscoveryRequest(new Request(`https://blast.test/api/launchpad/discovery?${query}`), engine);
  return response.json();
}

test("the browser accepts what the discovery resource serves, unchanged", async () => {
  for (const query of ["view=new&limit=3", "view=near_graduation", "view=graduated&limit=1"]) {
    const body = await served(query);
    assert.deepEqual(parseDiscoveryResponse(body), body, query);
  }
  const down = await served("view=new", "starting");
  assert.deepEqual(parseDiscoveryResponse(down), down);
});

test("optional metrics preserve original rows and cursor and isolate malformed enrichment", async () => {
  const body = await served("view=new&limit=3") as Record<string, unknown>;
  const legacy = { view: body.view, section: body.section };
  const before = parseDiscoveryResponse(legacy);
  assert.ok(before.section.state === "available" || before.section.state === "stale");
  const id = before.section.data.rows[0].launchId;
  const enriched = parseDiscoveryResponse({ ...legacy, metrics: { [id]: { holders: 0, market: { fake: "USD" } } } });
  assert.deepEqual(enriched.section, before.section);
  assert.deepEqual(enriched.metrics, { [id]: { holders: 0, market: null } });
  // Existing consumers read the strict original section; additional top-level fields are ignored.
  assert.deepEqual(parseDiscoveryResponse({ ...legacy, metrics: "bad" }).section, before.section);
});

test("a row that breaks the contract makes the section Unavailable, never a partial or guessed list", async () => {
  const body = (await served("view=new&limit=3")) as { view: string; section: { data: { rows: Record<string, unknown>[] } } };
  const broken = [
    { quoteRemaining: "-1" },
    { quoteRemaining: 0 },
    { progressBps: 10_001 },
    { lifecycle: "trending" },
    { launchId: "0x2" },
    { createdAtMs: "1790235061218" },
    { score: 99 },
  ];
  for (const change of broken) {
    const rows = body.section.data.rows.map((row, index) => (index === 1 ? { ...row, ...change } : row));
    const parsed = parseDiscoveryResponse({ ...body, section: { ...body.section, data: { ...body.section.data, rows } } });
    assert.deepEqual(parsed.section, { state: "unavailable", reason: "contract-violation" }, JSON.stringify(change));
  }
  assert.throws(() => parseDiscoveryResponse({ view: "hot", section: body.section }));
});

test("R3-23: a verified curve coin is marked from the response list; older bodies and bad lists change nothing", async () => {
  const engine = discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS });
  const get = async (query: string, read: VerifiedReader) =>
    (await (await handleDiscoveryRequest(new Request(`https://blast.test/api/launchpad/discovery?${query}`), engine, undefined, read)).json()) as Record<string, unknown>;
  for (const query of ["view=new&limit=3", "catalog=bonding&limit=3"]) {
    const plain = await get(query, async () => new Set());
    assert.equal("verifiedTeam" in plain, false, query);
    const legacy = parseDiscoveryResponse(plain);
    assert.ok(legacy.section.state === "available", query);
    const [first, ...rest] = legacy.section.data.rows;

    const body = await get(query, async (coinTypes) => {
      assert.ok(coinTypes.includes(first.coinType));
      return new Set([first.coinType, "0x9::not::Listed"]);
    });
    assert.deepEqual(body.verifiedTeam, [first.launchId], query);
    const marked = parseDiscoveryResponse(body);
    assert.ok(marked.section.state === "available");
    assert.equal(marked.section.data.rows[0].verifiedTeam, true);
    assert.deepEqual(marked.section.data.rows.slice(1), rest, "only the named launch is marked");

    // A failed trust read serves the page without the mark; a malformed list is ignored.
    assert.equal("verifiedTeam" in (await get(query, async () => { throw new Error("replica down"); })), false);
    for (const bad of ["bad", [1, null], { [first.launchId]: true }])
      assert.deepEqual(parseDiscoveryResponse({ ...plain, verifiedTeam: bad }).section, legacy.section);
  }
});
