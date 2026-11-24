import assert from "node:assert/strict";
import test from "node:test";

import type { SignerKind } from "../transaction/action-machine.ts";
import type { SignerSource } from "../transaction/controller.ts";
import { fixturePrivySigner, fixtureWalletSigner, type FixtureSignerBehavior } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { LaunchpadSigner } from "../transaction/signer.ts";
import { createMigrationFixtureChain, MIGRATION_LAUNCH_ID, type MigrationFixtureState } from "../../../../../../packages/core/test/fixtures/modules/launch-migration/fixtures.ts";
import { createMigrationFlow, type MigrationDiagnostic, type MigrationFlowState } from "./migration-flow.ts";

function harness(
  overrides: Partial<MigrationFixtureState> = {},
  options: Readonly<{ onSignature?: () => void; report?: (diagnostic: MigrationDiagnostic) => void }> = {},
) {
  const fixture = createMigrationFixtureChain(overrides);
  const counts = { signatures: 0, completions: [] as unknown[], diagnostics: [] as MigrationDiagnostic[] };
  const behavior: FixtureSignerBehavior = {
    onRequest: () => {
      counts.signatures += 1;
      options.onSignature?.();
    },
  };
  let connected: LaunchpadSigner | null = null;
  const signers: SignerSource = {
    kinds: ["privy", "wallet"],
    current: () => connected,
    async connect(kind: SignerKind) {
      connected = kind === "privy" ? fixturePrivySigner(behavior) : fixtureWalletSigner(behavior);
      return connected;
    },
  };
  let reviews = 0;
  const flow = createMigrationFlow({
    chain: { client: fixture.client, manifest: fixture.manifest, mode: "non-production" },
    signers,
    launchId: MIGRATION_LAUNCH_ID,
    venue: overrides.witness ?? "cetus",
    report: options.report ?? ((diagnostic) => void counts.diagnostics.push(diagnostic)),
    newReviewId: () => `review-${(reviews += 1)}`,
  });
  flow.onCompleted((completion) => void counts.completions.push(completion));
  return { fixture, counts, flow };
}

type Harness = ReturnType<typeof harness>;

const BUSY = new Set(["connecting", "preflighting", "signing", "reconciling"]);

async function settle({ flow }: Harness): Promise<MigrationFlowState> {
  for (let turn = 0; turn < 300; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const state = flow.getState();
    if (!BUSY.has(state.action.phase) && state.settlement.status !== "checking") return state;
  }
  throw new Error(`still ${flow.getState().action.phase} / ${flow.getState().settlement.status}`);
}

async function review(run: Harness, kind: SignerKind = "wallet") {
  run.flow.submit();
  if (run.flow.getState().action.phase === "choosing-signer") run.flow.chooseSigner(kind);
  return settle(run);
}

async function approve(run: Harness) {
  const state = run.flow.getState();
  assert.equal(state.action.phase, "review");
  if (state.action.phase !== "review") return assert.fail();
  run.flow.approve(state.action.review.id);
  return settle(run);
}

test("any connected signer completes a Cetus migration with one signature, closed only by the verified Migrated event", async () => {
  for (const kind of ["wallet", "privy"] as const) {
    const run = harness({ witness: "cetus" });
    await review(run, kind);
    const done = await approve(run);
    assert.equal(done.action.phase, "succeeded");
    assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
    assert.equal(run.counts.signatures, 1);
    assert.equal(run.fixture.calls.execute, 1);
    assert.equal(run.fixture.state.lifecycle, "migrated");
    assert.equal(run.counts.completions.length, 1);
    assert.deepEqual(run.counts.diagnostics, [
      { event: "migration_manual_used", venue: "cetus" },
      { event: "migration_manual_completed", venue: "cetus", by: "self" },
    ]);
  }
});

test("a Bluefin migration whose fee changed after review replaces the review and pays the new fee exactly", async () => {
  const run = harness({ witness: "bluefin", bluefinFee: 0n });
  await review(run);
  run.fixture.state.bluefinFee = 2_000_000_000n;
  const replaced = await approve(run);
  assert.equal(replaced.action.phase, "review");
  if (replaced.action.phase !== "review") return;
  const change = replaced.action.changes.find((entry) => entry.key === "pool-creation-fee");
  assert.deepEqual(change && [change.before, change.after], [
    "0 SUI (0 MIST), paid by you to Bluefin",
    "2 SUI (2000000000 MIST), paid by you to Bluefin",
  ]);
  assert.equal(run.counts.signatures, 0);
  const done = await approve(run);
  assert.equal(done.action.phase, "succeeded");
  assert.equal(run.fixture.state.lifecycle, "migrated", "Bluefin accepted exactly its configured fee");
});

test("when another wallet migrated first, fresh reconciliation reports that completion without a signature", async () => {
  const run = harness();
  run.fixture.migrateElsewhere();
  const state = await review(run);
  assert.equal(state.action.phase, "blocked");
  assert.deepEqual(state.settlement.status === "completed" && state.settlement.by, "another");
  assert.equal(run.counts.signatures, 0);
  assert.equal(run.fixture.calls.execute, 0);
  assert.deepEqual(run.counts.diagnostics, [{ event: "migration_manual_completed", venue: "cetus", by: "other" }]);
});

test("a migration that lands between review and approval closes the review as completed elsewhere", async () => {
  const run = harness();
  await review(run);
  run.fixture.migrateElsewhere();
  const state = await approve(run);
  assert.deepEqual(state.settlement.status === "completed" && state.settlement.by, "another");
  assert.equal(run.counts.signatures, 0);
  assert.equal(run.fixture.calls.execute, 0);
});

test("the loser of a race after signing reconciles from the launch's Migrated state and never submits again", async () => {
  const run: Harness = harness({}, { onSignature: () => run.fixture.migrateElsewhere() });
  await review(run);
  const state = await approve(run);
  assert.equal(state.action.phase, "failed");
  assert.deepEqual(state.settlement.status === "completed" && state.settlement.by, "another");
  assert.equal(run.fixture.calls.execute, 1);
  await settle(run);
  assert.equal(run.fixture.calls.execute, 1, "no second submission");
  assert.deepEqual(run.counts.diagnostics, [
    { event: "migration_manual_used", venue: "cetus" },
    { event: "migration_manual_completed", venue: "cetus", by: "other" },
  ]);
});

test("a failed simulation leaves the launch visibly ready and retryable", async () => {
  const run = harness({ simulation: "failure" });
  const blocked = await review(run);
  assert.equal(blocked.action.phase, "blocked");
  assert.equal(blocked.settlement.status, "still-ready");
  assert.match(blocked.settlement.status === "still-ready" ? blocked.settlement.message : "", /still shows this launch as migration ready/);
  assert.equal(run.counts.completions.length, 0);
  run.fixture.state.simulation = "success";
  await review(run);
  const done = await approve(run);
  assert.equal(done.action.phase, "succeeded");
  assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
});

test("an on-chain failure with the launch still ready is retryable, and the retry completes", async () => {
  const run = harness({ execution: "abort" });
  await review(run);
  const failed = await approve(run);
  assert.equal(failed.action.phase, "failed");
  assert.equal(failed.settlement.status, "still-ready");
  assert.equal(run.counts.completions.length, 0);
  assert.deepEqual(run.counts.diagnostics, [{ event: "migration_manual_used", venue: "cetus" }]);
  run.fixture.state.execution = "complete";
  await review(run);
  const done = await approve(run);
  assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
  assert.equal(run.fixture.calls.execute, 2);
});

test("when the launch cannot be read after a failure, nothing is claimed until a later check succeeds", async () => {
  const run = harness({ simulation: "failure" });
  // The node stops answering reads right after it simulates.
  run.fixture.hooks.afterSimulation = () => void (run.fixture.state.reads = "unavailable");
  const unverified = await review(run);
  assert.equal(unverified.action.phase, "blocked");
  assert.equal(unverified.settlement.status, "unverified");
  assert.equal(run.counts.completions.length, 0);
  run.fixture.migrateElsewhere();
  run.fixture.state.reads = "available";
  run.flow.checkAgain();
  const later = await settle(run);
  assert.deepEqual(later.settlement.status === "completed" && later.settlement.by, "another");
});

test("diagnostics never block or change the migration", async () => {
  const run = harness({}, {
    report: () => {
      throw new Error("analytics is down");
    },
  });
  await review(run);
  const done = await approve(run);
  assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
});

test("Bluefin refuses a fee that changed after signing; the launch stays ready and a fresh review pays the new fee", async () => {
  const run: Harness = harness({ witness: "bluefin", bluefinFee: 0n }, { onSignature: () => void (run.fixture.state.bluefinFee = 1_000_000_000n) });
  await review(run);
  const failed = await approve(run);
  assert.equal(failed.action.phase, "failed");
  assert.equal(failed.settlement.status, "still-ready");
  await review(run);
  const done = await approve(run);
  assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
});

test("after a lost submission answer, no new attempt can start; the landed transaction completes as this wallet's", async () => {
  const run = harness({ execution: "unknown" });
  await review(run);
  const lost = await approve(run);
  assert.equal(lost.action.phase, "ambiguous");
  assert.equal(run.fixture.state.lifecycle, "migrated", "the lost transaction landed");
  // Neither leaving the unresolved state nor starting over is possible.
  run.flow.acknowledge();
  run.flow.submit();
  run.flow.chooseSigner("wallet");
  const held = await settle(run);
  assert.equal(held.action.phase, "ambiguous");
  assert.equal(run.counts.signatures, 1);
  run.flow.recheck();
  const done = await settle(run);
  assert.equal(done.action.phase, "succeeded");
  assert.deepEqual(done.settlement.status === "completed" && [done.settlement.by, done.settlement.digest], ["you", lost.action.phase === "ambiguous" ? lost.action.digest : null]);
  assert.equal(run.fixture.calls.execute, 1);
  assert.deepEqual(run.counts.diagnostics, [
    { event: "migration_manual_used", venue: "cetus" },
    { event: "migration_manual_completed", venue: "cetus", by: "self" },
  ]);
});

test("a lost answer whose transaction is not yet confirmed allows no second migration until a recheck resolves it", async () => {
  const run = harness({ execution: "unknown", confirmation: "pending" });
  await review(run);
  const lost = await approve(run);
  assert.equal(lost.action.phase, "ambiguous");
  run.flow.recheck();
  const pending = await settle(run);
  assert.equal(pending.action.phase, "ambiguous");
  run.flow.acknowledge();
  run.flow.submit();
  const held = await settle(run);
  assert.equal(held.action.phase, "ambiguous");
  assert.equal(run.counts.signatures, 1);
  assert.equal(run.fixture.calls.execute, 1, "no second submission");
  run.fixture.state.confirmation = "checkpointed";
  run.flow.recheck();
  const done = await settle(run);
  assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
  assert.equal(run.fixture.calls.execute, 1);
});

test("a checkpointed transaction without Migrated is final, so the wallet may leave it and try again", async () => {
  const run = harness({ evidence: "missing" });
  await review(run);
  const missing = await approve(run);
  assert.equal(missing.action.phase, "ambiguous");
  assert.equal(missing.action.phase === "ambiguous" && missing.action.reason, "evidence-missing");
  run.flow.acknowledge();
  assert.equal(run.flow.getState().action.phase, "editing");
  run.fixture.state.evidence = "event";
  await review(run);
  const done = await approve(run);
  assert.deepEqual(done.settlement.status === "completed" && done.settlement.by, "you");
  assert.equal(run.fixture.calls.execute, 2);
});
