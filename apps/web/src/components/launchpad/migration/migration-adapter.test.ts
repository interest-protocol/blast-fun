import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { PreflightBlockCode } from "../transaction/action-machine.ts";
import { fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { runFreshPreflight } from "../transaction/preflight.ts";
import {
  createMigrationFixtureChain,
  MEME_B_TYPE,
  MIGRATION_LAUNCH_ID,
  migrationManifest,
  VENUE_FIXTURE_LINEAGE,
  type MigrationFixtureChain,
} from "../../../../../../packages/core/test/fixtures/modules/launch-migration/fixtures.ts";
import { cetusMemeSide } from "@blast/core/lib/launchpad/cetus-coin-order.ts";
import { migrationAdapter } from "./migration-adapter.ts";

const MIGRATORS = NON_PRODUCTION_MANIFEST.packages.migrators.packageId;

function preflight(fixture: MigrationFixtureChain, reviewId = "r1") {
  return runFreshPreflight({
    chain: { client: fixture.client, manifest: fixture.manifest, mode: "non-production" },
    signer: fixtureWalletSigner(),
    adapter: migrationAdapter,
    input: { launchId: MIGRATION_LAUNCH_ID },
    reviewId,
  });
}

async function ready(fixture: MigrationFixtureChain) {
  const { outcome } = await preflight(fixture);
  assert.equal(outcome.status, "ready", JSON.stringify(outcome.status === "blocked" ? outcome.block : null));
  if (outcome.status !== "ready") return assert.fail();
  const facts = Object.fromEntries(outcome.review.facts.map((fact) => [fact.key, fact.value]));
  const call = Transaction.from(outcome.review.transactionBytes)
    .getData()
    .commands.find((command) => command.MoveCall?.function === "migrate" && normalizeSuiAddress(command.MoveCall.package) === normalizeSuiAddress(MIGRATORS))?.MoveCall;
  return { review: outcome.review, facts, call: call ?? assert.fail("no migrate call") };
}

async function blockedWith(fixture: MigrationFixtureChain, code: PreflightBlockCode) {
  const { outcome } = await preflight(fixture);
  assert.equal(outcome.status, "blocked");
  if (outcome.status !== "blocked") return assert.fail();
  assert.equal(outcome.block.code, code, outcome.block.message);
  return outcome.block;
}

test("a Cetus CLMM launch migrates through Cetus with the manifest's recorded Cetus objects and its coin order", async () => {
  const fixture = createMigrationFixtureChain({ witness: "cetus" });
  const { facts, call } = await ready(fixture);
  assert.equal(normalizeSuiAddress(call.package), normalizeSuiAddress(MIGRATORS));
  assert.equal(call.module, "cetus");
  assert.equal(call.typeArguments.length, 4, "<Meme, Quote, CoinA, CoinB>");
  assert.equal(facts["launch-state"], "Migration ready, read from Sui now");
  assert.equal(facts.route, "Cetus CLMM, tick spacing 60, fee rate 3000");
  assert.equal(facts.pool, "New Cetus pool FROGGY / SUI (FROGGY is coin A)");
  assert.equal(facts.cost, "Network fee only");
  // The SDK budgets a Cetus migration at gross cost (its pool's storage differs between simulation and
  // execution): its build plugin probes once, then the review's own simulation runs.
  assert.equal(fixture.calls.simulate, 2);
});

test("Cetus orders a pool's coins by type name: Meme is coin A exactly when its name sorts after the Quote's", () => {
  const sui = "0x2::sui::SUI";
  assert.equal(cetusMemeSide("0x3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c::froggy::FROGGY", sui), "a");
  assert.equal(cetusMemeSide(MEME_B_TYPE, sui), "b");
  assert.equal(cetusMemeSide("0x2::zzz::ZZZ", sui), "a", "same address: the module decides");
});

test("a Meme that sorts before SUI is Cetus coin B, and the call carries <Meme, Quote, Quote, Meme>", async () => {
  const fixture = createMigrationFixtureChain({ witness: "cetus", memeType: MEME_B_TYPE });
  const { facts, call } = await ready(fixture);
  assert.equal(facts.pool, "New Cetus pool SUI / LOW (LOW is coin B)");
  assert.equal(call.typeArguments[2], call.typeArguments[1]);
  assert.equal(call.typeArguments[3], call.typeArguments[0]);
});

test("a Bluefin Spot launch migrates through Bluefin and the review shows the exact SUI pool-creation fee the signer pays", async () => {
  const fixture = createMigrationFixtureChain({ witness: "bluefin", bluefinFee: 1_250_000_000n });
  const { facts, call } = await ready(fixture);
  assert.equal(call.module, "bluefin");
  assert.equal(facts.route, "Bluefin Spot, tick spacing 60, fee rate 3000");
  assert.equal(facts["pool-creation-fee"], "1.25 SUI (1250000000 MIST), paid by you to Bluefin");
  assert.equal(facts.cost, "1.25 SUI pool-creation fee plus the network fee");
  assert.equal(facts.manager, "Your wallet becomes the new pool's manager (its reward emissions only)");
});

test("a zero Bluefin fee is shown as zero and still paid exactly", async () => {
  const fixture = createMigrationFixtureChain({ witness: "bluefin", bluefinFee: 0n });
  const { facts } = await ready(fixture);
  assert.equal(facts["pool-creation-fee"], "0 SUI (0 MIST), paid by you to Bluefin");
});

test("a wallet holding less than Bluefin's fee is told so before any signature", async () => {
  const fixture = createMigrationFixtureChain({ witness: "bluefin", bluefinFee: 5_000_000_000n, balance: 1_000_000_000n });
  const block = await blockedWith(fixture, "insufficient-balance");
  assert.match(block.message, /Bluefin charges 5 SUI to create the pool, and the network fee comes from the same SUI; your wallet holds 1 SUI/);
  assert.equal(fixture.calls.simulate, 0);
});

test("a launch that is not MigrationReady cannot be migrated, and one already Migrated says so", async () => {
  const live = await blockedWith(createMigrationFixtureChain({ lifecycle: "live" }), "stale-lifecycle");
  assert.match(live.message, /Live on Sui, not ready to migrate/);
  const migrated = await blockedWith(createMigrationFixtureChain({ lifecycle: "migrated" }), "stale-lifecycle");
  assert.match(migrated.message, /already migrated/);
});

test("an unsupported recorded route is refused with its reason and no alternative venue", async () => {
  const unknown = await blockedWith(createMigrationFixtureChain({ witness: "turbos" }), "stale-route");
  assert.match(unknown.message, /turbos/);
  assert.match(unknown.message, /no other venue/);
  const notAdmitted = createMigrationFixtureChain({ witness: "cetus" }, migrationManifest({ sets: ["bluefin"] }));
  const block = await blockedWith(notAdmitted, "stale-route");
  assert.match(block.message, /does not admit Cetus migrations/);
});

test("a venue whose recorded set is absent or not observed on Sui disables only that venue", async () => {
  const unrecorded = createMigrationFixtureChain({ witness: "bluefin" }, migrationManifest({ sets: ["cetus"], routes: ["cetus", "bluefin"] }));
  const block = await blockedWith(unrecorded, "stale-route");
  assert.match(block.message, /Bluefin migration is unavailable/);
  assert.match(block.message, /venue-unrecorded/);
  // The same deployment still signs a Cetus migration.
  await ready(createMigrationFixtureChain({ witness: "cetus" }, migrationManifest({ sets: ["cetus"], routes: ["cetus", "bluefin"] })));

  const missing = await blockedWith(createMigrationFixtureChain({ witness: "cetus", venueObjects: "missing" }), "stale-route");
  assert.match(missing.message, /Cetus migration is unavailable/);
  assert.match(missing.message, /runtime-unverified/);
});

test("a partial venue set is an invalid deployment: no action can be signed", async () => {
  const manifest = migrationManifest({ sets: ["cetus"] });
  const cetus = Object.fromEntries(
    Object.entries(manifest.sharedObjects.cetus ?? {}).filter(([name]) => name !== "burnManager"),
  );
  const partial = { ...manifest, sharedObjects: { ...manifest.sharedObjects, cetus } };
  const block = await blockedWith(createMigrationFixtureChain({ witness: "cetus" }, partial), "deployment-rejected");
  assert.match(block.message, /deployment is invalid/);
  assert.deepEqual(block.details, ["The external service could not complete this request. Retry shortly. Code: service_unavailable."]);
  assert.doesNotMatch(JSON.stringify(block), /cetus venue set is partial/);
});

test("the migration objects come only from the manifest's recorded venue set", async () => {
  const fixture = createMigrationFixtureChain({ witness: "cetus" });
  const { review } = await ready(fixture);
  const inputs = Transaction.from(review.transactionBytes).getData().inputs;
  const shared = new Set(inputs.flatMap((input) => (input.Object?.SharedObject ? [normalizeSuiAddress(input.Object.SharedObject.objectId)] : [])));
  for (const name of ["config", "pools", "burnManager"] as const) {
    assert.ok(shared.has(normalizeSuiAddress(VENUE_FIXTURE_LINEAGE.sharedObjects.cetus[name].objectId)), name);
  }
  assert.ok(!shared.has(normalizeSuiAddress(VENUE_FIXTURE_LINEAGE.sharedObjects.bluefin.config.objectId)));
});

test("a Bluefin fee leaves room for the network fee paid from the same SUI, or the wallet is told why it cannot sign", async () => {
  const exact = createMigrationFixtureChain({ witness: "bluefin", bluefinFee: 1_000_000_000n, balance: 1_000_000_000n });
  const block = await blockedWith(exact, "insufficient-balance");
  assert.match(block.message, /Bluefin charges 1 SUI to create the pool, and the network fee comes from the same SUI/);
  assert.match(block.message, /keep at least 1\.05 SUI/);
  assert.equal(exact.calls.simulate, 0);
  await ready(createMigrationFixtureChain({ witness: "bluefin", bluefinFee: 1_000_000_000n, balance: 1_050_000_000n }));
});
