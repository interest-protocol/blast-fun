import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { startCoinFixtureServer, type CoinFixtureServer } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixture-server.ts";
import { activityAnchor } from "@blast/core/modules/launchpad-contract/activity.ts";
import { sameOriginFetch, TEST_BLAST_INFRA_KEY, testMarketRoutes } from "../../../../test/fixtures/modules/launchpad-market/testing.ts";

import { browserMarketDependencies } from "../blast-infra-browser";
import { readActivityPage, readFlow } from "./activity-client";

let fixture: CoinFixtureServer;

before(async () => {
  // A blast-infra that refuses a request without this server's key.
  fixture = await startCoinFixtureServer({ apiKey: TEST_BLAST_INFRA_KEY });
});

after(() => fixture.close());

/** The browser's reads: this app's same-origin market routes, which relay blast-infra's /v1 with the key. */
const dependencies = (apiKey?: string | null) =>
  browserMarketDependencies(null, sameOriginFetch(testMarketRoutes(fixture.origin, { apiKey })));

test("the browser reads the classified activity page by page through the app's routes, which relay blast-infra's /v1", async () => {
  Object.assign(fixture.state, { indexed: "live", infra: "ok" });
  const first = await readActivityPage(COIN_FIXTURE.launchId, null, dependencies());
  if (first.kind !== "rows") return assert.fail(JSON.stringify(first));
  assert.equal(first.rows.length, 25);
  assert.equal(first.lagging, false);
  assert.equal(first.provenance.source, "blast-infra");
  const second = await readActivityPage(COIN_FIXTURE.launchId, first.next, dependencies());
  assert.equal(second.kind === "rows" && second.rows[0]?.position, "325990000:1:0:0");
  // A durable link reads from its record on: the record is the first row.
  const anchored = await readActivityPage(COIN_FIXTURE.launchId, activityAnchor(COIN_FIXTURE.launchId, "325910100:0:1:1").cursor, dependencies());
  assert.deepEqual(anchored.kind === "rows" && anchored.rows.slice(0, 2).map((row) => row.position), ["325910100:0:1:1", "325910100:0:1:0"]);
});

test("after migration the classified page holds the venue pool's swaps with the curve's rows; the flow comes from /v1 too", async () => {
  Object.assign(fixture.state, { indexed: "migrated", infra: "ok", venue: "ok" });
  const flow = await readFlow(COIN_FIXTURE.launchId, dependencies());
  if (flow.kind !== "flow") return assert.fail(JSON.stringify(flow));
  assert.deepEqual(flow.flow.windows.all, { netQuoteFlow: 188_000_000_000n, buyers: 11, sellers: 6 });
  const page = await readActivityPage(COIN_FIXTURE.launchId, null, dependencies());
  if (page.kind !== "rows") return assert.fail(JSON.stringify(page));
  assert.deepEqual(page.rows.slice(0, 3).map((row) => [row.position, row.kind]), [
    ["326274000:1:1:0", "venue_buy"],
    ["326254000:0:1:0", "venue_sell"],
    ["326234000:0:1:0", "venue_buy"],
  ]);
  assert.deepEqual(page.rows[0]?.labels, ["whale"]);
  // The curve's claims sit between the swaps, in position order.
  const kinds = page.rows.map((row) => row.kind);
  assert.ok(kinds.indexOf("protocol_fees_claimed") > kinds.indexOf("venue_buy"));
  assert.ok(kinds.indexOf("migration") > kinds.indexOf("creator_fees_claimed"));
});

test("a starting, unreachable or refusing blast-infra is a failed read with its reason", async () => {
  Object.assign(fixture.state, { indexed: "live", infra: "starting", venue: "ok" });
  assert.deepEqual(await readActivityPage(COIN_FIXTURE.launchId, null, dependencies()), { kind: "failed", reason: "unavailable" });
  assert.deepEqual(await readFlow(COIN_FIXTURE.launchId, dependencies()), { kind: "failed", reason: "unavailable" });
  Object.assign(fixture.state, { infra: "down" });
  assert.deepEqual(await readActivityPage(COIN_FIXTURE.launchId, null, dependencies()), { kind: "failed", reason: "unreachable" });
  Object.assign(fixture.state, { infra: "lagging" });
  const lagging = await readActivityPage(COIN_FIXTURE.launchId, null, dependencies());
  assert.equal(lagging.kind === "rows" && lagging.lagging, true);
  Object.assign(fixture.state, { infra: "ok" });
  // Another list's token never reaches blast-infra.
  assert.deepEqual(await readActivityPage(COIN_FIXTURE.launchId, "not-a-token", dependencies()), { kind: "failed", reason: "invalid_parameter" });
  // A server without blast-infra's key reads nothing: the route answers Unavailable, never the refusal's words.
  assert.deepEqual(await readActivityPage(COIN_FIXTURE.launchId, null, dependencies(null)), { kind: "failed", reason: "unavailable" });
});
