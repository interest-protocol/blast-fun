import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { BluefinVenueError, CetusVenueError } from "@interest-protocol/blast-sdk/migrators";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { resolveBluefinRecord } from "./venue-bluefin.ts";
import { resolveCetusRecord } from "./venue-cetus.ts";
import { readVenueRoute } from "./venue-route.ts";
import {
  BLUEFIN_LAUNCH_ID,
  BLUEFIN_MEME_TYPE,
  BLUEFIN_MIGRATION_DIGEST,
  BLUEFIN_POOL_ID,
  BLUEFIN_VAULT_ID,
  CETUS_LAUNCH_ID,
  CETUS_MIGRATION_DIGEST,
  CETUS_POOL_ID,
  CETUS_VAULT_ID,
  createVenueFixtureChain,
  OTHER_BLUEFIN_POOL_ID,
  OTHER_CETUS_POOL_ID,
  OTHER_MIGRATION_DIGEST,
  VENUE_FIXTURE_MANIFEST,
  VENUE_MEME_TYPE,
} from "../../../../test/fixtures/launchpad/trade/venue-fixtures.ts";

const deployment = defineBlastDeployment(VENUE_FIXTURE_MANIFEST);
const NOW = 1_790_000_000_000;
const cetus = { launchId: CETUS_LAUNCH_ID, migrationDigest: CETUS_MIGRATION_DIGEST, poolKey: `cetus:${CETUS_POOL_ID}` };

test("a Cetus launch's route comes from its migration's vault and pool, checked by the SDK against the deployment", async () => {
  const read = await readVenueRoute(createVenueFixtureChain().client, deployment, cetus, NOW);
  assert.equal(read.status, "ok", read.status === "ok" ? "" : read.message);
  if (read.status !== "ok" || read.recorded.venue !== "cetus") return assert.fail("not a Cetus route");
  const { route } = read.recorded.cetus;
  assert.equal(route.venue, "cetus");
  assert.equal(route.vaultId, CETUS_VAULT_ID);
  assert.equal(route.pool.objectId, CETUS_POOL_ID);
  assert.equal(route.memeType, VENUE_MEME_TYPE);
  assert.equal(route.memeIsCoinA, false);
  assert.equal(route.tickSpacing, 200);
  assert.equal(route.feeRate, 10_000n);
  assert.equal(route.cetusPackageId, VENUE_FIXTURE_MANIFEST.packages.cetusClmm.packageId);
  assert.equal(read.recorded.symbol, "FROG");
  assert.equal(read.recorded.decimals, 9);
});

const bluefin = { launchId: BLUEFIN_LAUNCH_ID, migrationDigest: BLUEFIN_MIGRATION_DIGEST, poolKey: `bluefin:${BLUEFIN_POOL_ID}` };

test("a Bluefin launch's route comes from its migration's vault and pool, checked by the SDK's Bluefin adapter against the deployment", async () => {
  const read = await readVenueRoute(createVenueFixtureChain().client, deployment, bluefin, NOW);
  assert.equal(read.status, "ok", read.status === "ok" ? "" : read.message);
  if (read.status !== "ok" || read.recorded.venue !== "bluefin") return assert.fail("not a Bluefin route");
  const { route } = read.recorded.bluefin;
  assert.equal(route.venue, "bluefin");
  assert.equal(route.vaultId, BLUEFIN_VAULT_ID);
  assert.equal(route.pool.objectId, BLUEFIN_POOL_ID);
  assert.equal(route.memeType, BLUEFIN_MEME_TYPE);
  assert.equal(route.tickSpacing, 60);
  assert.equal(route.feeRate, 3_000n);
  assert.equal(route.bluefinPackageId, VENUE_FIXTURE_MANIFEST.packages.bluefinSpot.packageId);
  assert.equal(route.bluefinConfig.objectId, VENUE_FIXTURE_MANIFEST.sharedObjects.bluefin.config.objectId);
  assert.equal(read.recorded.symbol, "NEWT");
  // Decimals come from the launch's canonical supply, never assumed.
  assert.equal(read.recorded.decimals, 6);
});

test("a page naming another Bluefin pool, the Bluefin pool under Cetus, or another launch's migration cannot substitute the recorded Bluefin route", async () => {
  const { client } = createVenueFixtureChain();
  const refusal = async (locator: typeof bluefin) => {
    const read = await readVenueRoute(client, deployment, locator, NOW);
    return read.status === "refused" ? `${read.code}: ${read.message}` : read.status;
  };
  assert.match(await refusal({ ...bluefin, poolKey: `bluefin:${OTHER_BLUEFIN_POOL_ID}` }), /^route-substitution: The page names pool bluefin:0x7b7b.*but this launch recorded bluefin:0x4b4b/);
  // The Cetus adapter cannot be substituted for the recorded Bluefin route.
  assert.match(await refusal({ ...bluefin, poolKey: `cetus:${BLUEFIN_POOL_ID}` }), /^route-substitution: .*this launch recorded bluefin:/);
  assert.match(await refusal({ ...bluefin, migrationDigest: OTHER_MIGRATION_DIGEST }), /^route-substitution: Transaction .* is not this launch's migration\./);
  assert.match(await refusal({ ...bluefin, migrationDigest: CETUS_MIGRATION_DIGEST }), /^route-substitution: Transaction .* is not this launch's migration\./);
});

test("neither venue's driver resolves the other venue's recorded pool", async () => {
  const { client } = createVenueFixtureChain();
  const launch = async (launchId: string) => {
    const read = await readVenueRoute(client, deployment, { launchId, migrationDigest: launchId === CETUS_LAUNCH_ID ? CETUS_MIGRATION_DIGEST : BLUEFIN_MIGRATION_DIGEST, poolKey: null }, NOW);
    if (read.status !== "ok") throw new Error(read.message);
    return read.recorded;
  };
  const [cetusLaunch, bluefinLaunch] = [await launch(CETUS_LAUNCH_ID), await launch(BLUEFIN_LAUNCH_ID)];
  await assert.rejects(resolveCetusRecord(client, deployment, bluefinLaunch.launch, bluefinLaunch.vault), (error: unknown) => error instanceof CetusVenueError && error.code === "foreign-lineage");
  await assert.rejects(resolveBluefinRecord(client, deployment, cetusLaunch.launch, cetusLaunch.vault), (error: unknown) => error instanceof BluefinVenueError && error.code === "foreign-lineage");
});

test("a deployment that records no Bluefin lineage, another Bluefin lineage, or not the launch's Bluefin tier refuses the route", async () => {
  const { client } = createVenueFixtureChain();
  const packages = Object.fromEntries(Object.entries(VENUE_FIXTURE_MANIFEST.packages).filter(([name]) => name !== "bluefinSpot"));
  const sharedObjects = Object.fromEntries(Object.entries(VENUE_FIXTURE_MANIFEST.sharedObjects).filter(([name]) => name !== "bluefin"));
  const foreign = { packageId: normalizeSuiAddress(`0x${"f1".repeat(32)}`), originalPackageId: normalizeSuiAddress(`0x${"f1".repeat(32)}`) };
  const manifests = {
    "deployment-mismatch": { ...VENUE_FIXTURE_MANIFEST, packages, sharedObjects },
    "foreign-lineage": { ...VENUE_FIXTURE_MANIFEST, packages: { ...VENUE_FIXTURE_MANIFEST.packages, bluefinSpot: foreign } },
    "unsupported-tier": { ...VENUE_FIXTURE_MANIFEST, routes: [VENUE_FIXTURE_MANIFEST.routes[0], { venue: "bluefin", tiers: [{ tickSpacing: 200, feeRate: "10000" }] }] },
  } as const;
  for (const [code, manifest] of Object.entries(manifests)) {
    const read = await readVenueRoute(client, defineBlastDeployment(manifest), bluefin, NOW);
    assert.equal(read.status === "refused" && read.code, code);
    assert.doesNotMatch(read.status === "refused" ? read.message : "", /config::|0x[0-9a-f]{64}/);
    assert.equal(read.status === "refused" ? read.message : "", `The recorded Bluefin Spot route does not match this launch. Nothing can be signed. Code: ${code}.`);
  }
});

test("a Bluefin fee change or a Bluefin pool layout change closes the route with that reason; a missing pool is unavailable", async () => {
  const fee = await readVenueRoute(createVenueFixtureChain({ bluefinFeeRate: 2_500n }).client, deployment, bluefin, NOW);
  assert.equal(fee.status === "refused" && fee.code, "route-substitution");
  assert.match(fee.status === "refused" ? fee.message : "", /^The recorded Bluefin Spot route does not match this launch\. Nothing can be signed\. Code: route-substitution\.$/);
  const layout = await readVenueRoute(createVenueFixtureChain({ bluefinPoolLayout: "changed" }).client, deployment, bluefin, NOW);
  assert.equal(layout.status === "refused" && layout.code, "unsupported-route");
  assert.match(layout.status === "refused" ? layout.message : "", /is not in the Bluefin Spot v17 layout this app reads .*Bluefin trading stays closed until the app is updated/);
  const missing = await readVenueRoute(createVenueFixtureChain({ bluefinPoolObject: "absent" }).client, deployment, bluefin, NOW);
  assert.equal(missing.status, "unavailable");
  assert.match(missing.status === "unavailable" ? missing.message : "", /^The external service could not complete this request\. Retry shortly\. Code: service_unavailable\.$/);
});

test("a page naming another pool, or another launch's migration, cannot substitute the recorded route", async () => {
  const { client } = createVenueFixtureChain();
  const pool = await readVenueRoute(client, deployment, { ...cetus, poolKey: `cetus:${OTHER_CETUS_POOL_ID}` }, NOW);
  assert.equal(pool.status === "refused" && pool.code, "route-substitution");
  const bluefinKey = await readVenueRoute(client, deployment, { ...cetus, poolKey: `bluefin:${CETUS_POOL_ID}` }, NOW);
  assert.equal(bluefinKey.status === "refused" && bluefinKey.code, "route-substitution");
  const migration = await readVenueRoute(client, deployment, { ...cetus, migrationDigest: OTHER_MIGRATION_DIGEST }, NOW);
  assert.equal(migration.status === "refused" && migration.code, "route-substitution");
});

test("a deployment without the launch's Cetus tier refuses the route", async () => {
  const narrowed = defineBlastDeployment({
    ...VENUE_FIXTURE_MANIFEST,
    routes: [{ venue: "cetus", tiers: [{ tickSpacing: 60, feeRate: "2500" }] }, ...VENUE_FIXTURE_MANIFEST.routes.slice(1)],
  });
  const read = await readVenueRoute(createVenueFixtureChain().client, narrowed, cetus, NOW);
  assert.equal(read.status === "refused" && read.code, "unsupported-tier");
});

test("without the migration record or a node, the route is unavailable, not refused", async () => {
  const fixture = createVenueFixtureChain();
  const missing = await readVenueRoute(fixture.client, deployment, { ...cetus, migrationDigest: null }, NOW);
  assert.equal(missing.status, "unavailable");
  fixture.state.reads = "unavailable";
  const down = await readVenueRoute(fixture.client, deployment, cetus, NOW);
  assert.equal(down.status, "unavailable");
});

test("a quote provider outage leaves the recorded route, its pool and the launch readable", async () => {
  const fixture = createVenueFixtureChain({ simulation: "unavailable", cetusConfig: "mismatch" });
  const read = await readVenueRoute(fixture.client, deployment, cetus, NOW);
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.recorded.launch.lifecycle, "Migrated");
  assert.equal(fixture.calls.simulate, 0);
});
