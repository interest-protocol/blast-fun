import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { startCoinFixtureServer, type CoinFixtureServer } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixture-server.ts";
import { sameOriginFetch, TEST_BLAST_INFRA_KEY, testMarketRoutes } from "../../../../test/fixtures/modules/launchpad-market/testing.ts";

import { browserMarketDependencies } from "../blast-infra-browser";
import { readFees, type FeesSource } from "./fees-client";

let fixture: CoinFixtureServer;

before(async () => {
  // A blast-infra that refuses a request without this server's key.
  fixture = await startCoinFixtureServer({ apiKey: TEST_BLAST_INFRA_KEY });
});

after(() => fixture.close());

const SOURCE: FeesSource = {
  launchId: COIN_FIXTURE.launchId,
  expected: null,
  units: { symbol: "FROGGY", memeDecimals: 6, quoteSymbol: "SUI", quoteDecimals: 9 },
};

/** The browser's reads: this app's same-origin market routes, which relay blast-infra's /v1 with the key. */
const dependencies = (apiKey?: string | null) =>
  browserMarketDependencies(null, sameOriginFetch(testMarketRoutes(fixture.origin, { apiKey })));

test("the browser reads the launch's fees through the app's route: the curve alone before migration, then the vault too", async () => {
  Object.assign(fixture.state, { indexed: "live", infra: "ok" });
  const live = await readFees(SOURCE, dependencies());
  if (live.kind !== "rewards") return assert.fail(JSON.stringify(live));
  assert.equal(live.rewards.vault, null);
  assert.equal(live.provenance.source, "blast-infra");
  Object.assign(fixture.state, { indexed: "migrated" });
  const migrated = await readFees(SOURCE, dependencies());
  assert.equal(migrated.kind === "rewards" && migrated.rewards.vault?.collected.meme, 1_000_000_000n);
});

test("a starting, unreachable or refusing blast-infra is a failed read with its reason", async () => {
  Object.assign(fixture.state, { indexed: "live", infra: "starting" });
  assert.deepEqual(await readFees(SOURCE, dependencies()), { kind: "failed", reason: "unavailable" });
  Object.assign(fixture.state, { infra: "down" });
  assert.deepEqual(await readFees(SOURCE, dependencies()), { kind: "failed", reason: "unreachable" });
  Object.assign(fixture.state, { infra: "ok" });
  assert.deepEqual(await readFees(SOURCE, dependencies(null)), { kind: "failed", reason: "unavailable" });
  assert.deepEqual(await readFees({ ...SOURCE, launchId: "0x1" }, dependencies()), { kind: "failed", reason: "invalid_parameter" });
});
