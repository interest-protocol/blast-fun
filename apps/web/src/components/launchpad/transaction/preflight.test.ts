import assert from "node:assert/strict";
import test from "node:test";

import { toBase64 } from "@mysten/sui/utils";

import type { PreflightBlockCode } from "./action-machine.ts";
import {
  createFixtureChain,
  fixtureBuyAdapter,
  fixtureLaunch,
  fixturePrivySigner,
  fixtureWalletSigner,
  FIXTURE_BUILD_ABORT,
  FIXTURE_LAUNCH_ID,
  FOREIGN_CHAIN_IDENTIFIER,
  NON_PRODUCTION_MANIFEST,
  type FixtureChain,
} from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { runFreshPreflight, type LaunchpadChain } from "./preflight.ts";
import type { LaunchpadSigner } from "./signer.ts";

const input = { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" };

function chainFor(fixture: FixtureChain, overrides: Partial<LaunchpadChain> = {}): LaunchpadChain {
  return { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production", ...overrides };
}

function preflight(fixture: FixtureChain, signer: LaunchpadSigner = fixtureWalletSigner(), overrides: Partial<LaunchpadChain> = {}) {
  return runFreshPreflight({ chain: chainFor(fixture, overrides), signer, adapter: fixtureBuyAdapter, input, reviewId: "r1" });
}

async function blockedWith(promise: ReturnType<typeof runFreshPreflight>, code: PreflightBlockCode) {
  const { outcome } = await promise;
  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.status === "blocked" && outcome.block.code, code, JSON.stringify(outcome));
  return outcome.status === "blocked" ? outcome.block : assert.fail();
}

test("a fresh review carries network, signer, SDK preview facts, and the exact simulated bytes", async () => {
  const fixture = createFixtureChain();
  const signer = fixturePrivySigner();
  const { outcome, deployment } = await preflight(fixture, signer);
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  assert.equal(deployment?.network, "mainnet");
  assert.deepEqual(outcome.review.signer, { kind: "privy", address: signer.address, chain: "sui:mainnet" });
  const facts = Object.fromEntries(outcome.review.facts.map((fact) => [fact.key, fact.value]));
  assert.equal(facts.network, "Sui mainnet");
  assert.match(facts.signer, /^Privy wallet 0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  assert.equal(facts["quote-in"], "12.5 SUI");
  assert.equal(facts["meme-out"], "2,467,366.584628804 MEME", "worked example of launch::buy over the fresh curve");
  assert.equal(facts.fee, "0.125 SUI");
  assert.equal(fixture.calls.simulate, 1);
  assert.ok(outcome.review.transactionBytes.length > 0);
  assert.equal(typeof toBase64(outcome.review.transactionBytes), "string");
});

test("a production manifest cannot sign while no Blast deployment is released", async () => {
  const block = await blockedWith(
    preflight(createFixtureChain(), fixtureWalletSigner(), { mode: "production" }),
    "deployment-rejected",
  );
  assert.equal(block.stage, "deployment");
  assert.ok(block.details.some((detail) => detail.startsWith("environment-mismatch")));
});

test("a node on another chain is a deployment mismatch", async () => {
  const block = await blockedWith(
    preflight(createFixtureChain({ chainIdentifier: FOREIGN_CHAIN_IDENTIFIER })),
    "deployment-rejected",
  );
  assert.ok(block.details.some((detail) => detail.startsWith("runtime-mismatch")));
});

test("a wrong-network signer is blocked before any object read or simulation", async () => {
  const fixture = createFixtureChain();
  const block = await blockedWith(preflight(fixture, fixtureWalletSigner({}, ["sui:testnet"])), "wrong-network");
  assert.equal(block.stage, "signer");
  assert.equal(block.message, "Fixture wallet is set to Sui testnet. Switch it to Sui mainnet, then review again. Code: wrong-network.");
  assert.equal(fixture.calls.simulate, 0);
});

test("unavailable fresh reads fail closed", async () => {
  const block = await blockedWith(preflight(createFixtureChain({ reads: "unavailable" })), "fresh-read-unavailable");
  assert.equal(block.stage, "deployment");
});

test("an object missing on this network or from another package lineage is rejected", async () => {
  const missing = await blockedWith(preflight(createFixtureChain({ launch: null })), "object-unavailable");
  assert.equal(missing.message, "The launch does not exist on Sui mainnet. Code: object-unavailable.");
  const foreign = await blockedWith(
    preflight(createFixtureChain({ launch: fixtureLaunch({ lineage: "foreign" }) })),
    "foreign-lineage",
  );
  assert.equal(foreign.message, "The launch does not belong to this Blast deployment. Code: foreign-lineage.");
});

test("fresh object state overrides stale indexed eligibility in both directions", async () => {
  // The indexed dashboard still says the curve is open; the object has migrated.
  await blockedWith(preflight(createFixtureChain({ launch: fixtureLaunch({ lifecycle: "migrated" }) })), "stale-lifecycle");
  // The indexed dashboard lags a top-up; the fresh balance covers the purchase.
  const signer = fixtureWalletSigner();
  const funded = createFixtureChain({ balances: { [signer.address]: 20_000_000_000n } });
  assert.equal((await preflight(funded, signer)).outcome.status, "ready");
  const short = createFixtureChain({ balances: { [signer.address]: 1_000_000_000n } });
  await blockedWith(preflight(short, signer), "insufficient-balance");
});

test("a preview the SDK refuses blocks the signature", async () => {
  const fixture = createFixtureChain();
  const { outcome } = await runFreshPreflight({
    chain: chainFor(fixture),
    signer: fixtureWalletSigner(),
    adapter: fixtureBuyAdapter,
    input: { ...input, amount: "0.000000001" },
    reviewId: "r1",
  });
  assert.equal(outcome.status === "blocked" && outcome.block.code, "preview-unavailable");
});

test("a failed or unavailable simulation fails closed", async () => {
  const failed = await blockedWith(preflight(createFixtureChain({ simulation: "failure" })), "simulation-failed");
  assert.equal(failed.message, "Sui rejected this transaction in simulation: the network rejected it. Nothing was signed. Code: simulation-failed.");
  assert.doesNotMatch(failed.message, /abort 7/);
  await blockedWith(preflight(createFixtureChain({ simulation: "unavailable" })), "simulation-unavailable");
});

test("a transaction the client's build-time simulation refuses is Sui's refusal in simulation, with the execution error", async () => {
  // A Core API client without a gas budget simulates while building; a Move abort there fails the build.
  const fixture = createFixtureChain({ build: "execution-error" });
  const block = await blockedWith(preflight(fixture), "simulation-failed");
  assert.equal(block.stage, "simulation");
  assert.equal(block.message, "The contract refused this launch: the sell burn is above its ceiling (abort 7). Code: simulation-failed.");
  assert.equal(block.field, "sellBurn");
  assert.ok(!block.message.includes(FIXTURE_BUILD_ABORT));
  assert.deepEqual(block.details, []);
  assert.equal(fixture.calls.simulate, 0);
});

test("a build that fails without an execution error is a node that cannot be asked, never Sui's refusal", async () => {
  // The gRPC client wraps a dropped connection during resolution as a SimulationError without an execution error.
  for (const [build, detail] of [["transport-error", "14 UNAVAILABLE: Connection dropped"], ["error", "socket hang up"]] as const) {
    const fixture = createFixtureChain({ build });
    const block = await blockedWith(preflight(fixture), "simulation-unavailable");
    assert.equal(block.stage, "simulation", build);
    assert.equal(block.message, "Blast could not prepare this transaction for simulation. Nothing was signed. Try again shortly. Code: simulation-unavailable.", build);
    assert.deepEqual(block.details, ["The external service could not complete this request. Retry shortly. Code: service_unavailable."], build);
    assert.ok(!JSON.stringify(block).includes(detail), "raw transport diagnostics remain private");
    assert.equal(fixture.calls.simulate, 0, build);
  }
});

test("a wallet without SUI for gas gets funding guidance rather than an unavailable simulation", async (t) => {
  for (const message of [
    `Unable to perform gas selection due to insufficient SUI balance (in address balance or coins) for account ${fixtureWalletSigner().address} to satisfy required budget 2921445.`,
    "No valid gas coins found for the transaction.",
  ]) {
    const fixture = createFixtureChain();
    const build = fixtureBuyAdapter.build;
    const adapter = { ...fixtureBuyAdapter, build: (...args: Parameters<typeof build>) => {
      const tx = build(...args);
      t.mock.method(tx, "build", async () => { throw new Error(message); });
      return tx;
    }};
    const block = await blockedWith(runFreshPreflight({ chain: chainFor(fixture), signer: fixtureWalletSigner(), adapter, input, reviewId: "gas" }), "insufficient-balance");
    assert.equal(block.message, "Your wallet needs SUI for the network fee. Add SUI to this wallet, then review again. Nothing was signed. Code: insufficient-balance.");
    assert.deepEqual(block.details, []);
    assert.equal(fixture.calls.simulate, 0);
  }
});
