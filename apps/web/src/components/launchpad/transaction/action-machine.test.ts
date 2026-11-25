import assert from "node:assert/strict";
import test from "node:test";

import {
  diffMaterialFacts,
  initialActionState,
  reduceAction,
  REJECTED_MESSAGE,
  type ActionEvent,
  type ActionPhase,
  type FreshReview,
  type ReconciliationOutcome,
} from "./action-machine.ts";
import { actionStateFixtures } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";

type Input = Readonly<{ amount: string }>;

const input: Input = { amount: "12.5" };

test("submitting without a signer asks which signer to use and keeps the entered amount", () => {
  const state = reduceAction(initialActionState(input), { type: "submit", signer: null });
  assert.equal(state.phase, "choosing-signer");
  assert.deepEqual(state.input, input);
});


const signer = { kind: "wallet", address: "0xa11ce", chain: "sui:localnet" } as const;

function review(id: string, value = "1000"): FreshReview {
  return {
    id,
    facts: [
      { key: "network", label: "Network", value: "Sui localnet" },
      { key: "meme-out", label: "You receive at least", value },
    ],
    signer,
    deploymentFingerprint: "fp",
    transactionBytes: new Uint8Array([1, 2, 3]),
  };
}

function run(events: readonly ActionEvent<Input>[], start = initialActionState(input)) {
  return events.reduce(reduceAction<Input>, start);
}

function reviewing(id = "r1") {
  const preflighting = run([{ type: "submit", signer }]);
  return reduceAction(preflighting, {
    type: "preflight-resolved",
    attempt: preflighting.attempt,
    outcome: { status: "ready", review: review(id) },
  });
}

function signing() {
  const approving = reduceAction(reviewing(), { type: "approve", reviewId: "r1" });
  return reduceAction(approving, {
    type: "preflight-resolved",
    attempt: approving.attempt,
    outcome: { status: "ready", review: review("r2") },
  });
}

test("a signer connection starts only after the user picks a signer, then a fresh review begins", () => {
  const choosing = run([{ type: "submit", signer: null }]);
  const connecting = reduceAction(choosing, { type: "choose-signer", kind: "privy" });
  assert.equal(connecting.phase, "connecting");
  assert.equal(connecting.phase === "connecting" && connecting.signerKind, "privy");
  const stale = reduceAction(connecting, { type: "signer-connected", attempt: choosing.attempt, signer });
  assert.equal(stale.phase, "connecting", "a connection result for another attempt is ignored");
  const preflighting = reduceAction(connecting, { type: "signer-connected", attempt: connecting.attempt, signer });
  assert.equal(preflighting.phase, "preflighting");
  assert.equal(preflighting.phase === "preflighting" && preflighting.purpose, "review");
});

test("a failed connection returns to the entry with guidance and the amount intact", () => {
  const connecting = run([{ type: "submit", signer: null }, { type: "choose-signer", kind: "wallet" }]);
  const state = reduceAction(connecting, { type: "signer-unavailable", attempt: connecting.attempt, message: "Slush is not installed." });
  assert.deepEqual(state, { phase: "editing", input, attempt: connecting.attempt, notice: { tone: "caution", message: "Slush is not installed." } });
});

test("a blocked preflight shows why and offers no review until the user reviews again", () => {
  const preflighting = run([{ type: "submit", signer }]);
  const block = {
    stage: "signer",
    code: "wrong-network",
    message: "Switch your wallet to Sui localnet, then review again.",
    details: [],
  } as const;
  const blocked = reduceAction(preflighting, { type: "preflight-resolved", attempt: preflighting.attempt, outcome: { status: "blocked", block } });
  assert.equal(blocked.phase, "blocked");
  assert.deepEqual(blocked.phase === "blocked" && blocked.block, block);
  assert.equal(reduceAction(blocked, { type: "approve", reviewId: "r1" }), blocked, "nothing to approve");
  assert.equal(reduceAction(blocked, { type: "submit", signer }).phase, "preflighting");
});

test("approval refreshes the review; unchanged facts go to one signature with the fresh bytes", () => {
  const state = reviewing();
  assert.equal(state.phase, "review");
  assert.equal(reduceAction(state, { type: "approve", reviewId: "old" }), state, "a stale approval is ignored");
  const approved = signing();
  assert.equal(approved.phase, "signing");
  assert.equal(approved.phase === "signing" && approved.review.id, "r2");
});

test("a material change during approval replaces the review and waits for another confirmation", () => {
  const approving = reduceAction(reviewing(), { type: "approve", reviewId: "r1" });
  const changed = reduceAction(approving, {
    type: "preflight-resolved",
    attempt: approving.attempt,
    outcome: { status: "ready", review: review("r2", "940") },
  });
  assert.equal(changed.phase, "review");
  assert.equal(changed.phase === "review" && changed.review.id, "r2");
  assert.deepEqual(changed.phase === "review" && changed.changes, [
    { key: "meme-out", label: "You receive at least", before: "1000", after: "940" },
  ]);
  const reconfirmed = reduceAction(changed, { type: "approve", reviewId: "r2" });
  assert.equal(reconfirmed.phase, "preflighting");
});

test("a preflight result that arrives after the user cancelled is ignored", () => {
  const preflighting = run([{ type: "submit", signer }]);
  const cancelled = reduceAction(preflighting, { type: "cancel" });
  assert.equal(cancelled.phase, "preflighting", "a running preflight cannot be cancelled mid-read");
  const back = run([{ type: "cancel" }], reviewing());
  assert.equal(back.phase, "editing");
  const late = reduceAction(back, { type: "preflight-resolved", attempt: back.attempt - 1, outcome: { status: "ready", review: review("late") } });
  assert.equal(late, back);
});

test("a declined signature keeps the entry and waits for the user; nothing re-signs", () => {
  const state = signing();
  const rejected = reduceAction(state, { type: "signature-rejected", attempt: state.attempt });
  assert.deepEqual(rejected, { phase: "rejected", input, attempt: state.attempt, message: REJECTED_MESSAGE });
  assert.equal(reduceAction(rejected, { type: "submitted", attempt: state.attempt, digest: "D" }), rejected);
  assert.equal(reduceAction(rejected, { type: "submit", signer }).phase, "preflighting", "only an explicit submit starts again");
});

test("an unknown submission stays ambiguous; only rechecking the same digest or acknowledging leaves it", () => {
  const state = signing();
  const ambiguous = reduceAction(state, { type: "submission-unknown", attempt: state.attempt, digest: "Dg", message: "The node did not answer." });
  assert.equal(ambiguous.phase, "ambiguous");
  assert.equal(reduceAction(ambiguous, { type: "submit", signer }), ambiguous, "no new submission from an ambiguous state");
  assert.equal(reduceAction(ambiguous, { type: "edit", input: { amount: "1" } }), ambiguous);
  const recheck = reduceAction(ambiguous, { type: "recheck" });
  assert.equal(recheck.phase, "reconciling");
  assert.equal(recheck.phase === "reconciling" && recheck.digest, "Dg");
  const acknowledged = reduceAction(ambiguous, { type: "acknowledge" });
  assert.equal(acknowledged.phase, "editing");
  assert.deepEqual(acknowledged.input, input);
  assert.match(acknowledged.phase === "editing" ? acknowledged.notice?.message ?? "" : "", /Dg is still unresolved/);
});

test("reconciliation decides success, on-chain failure, or a pending result", () => {
  const state = signing();
  const reconciling = reduceAction(state, { type: "submitted", attempt: state.attempt, digest: "Dg" });
  assert.equal(reconciling.phase, "reconciling");
  assert.equal(reduceAction(reconciling, { type: "edit", input: { amount: "2" } }), reconciling, "no edits mid-flight");
  const done = (outcome: ReconciliationOutcome) =>
    reduceAction(reconciling, { type: "reconciled", attempt: reconciling.attempt, outcome });
  const succeeded = done({ status: "succeeded", explorerUrl: "https://suiscan.xyz/mainnet/tx/Dg", checkpoint: 41 });
  assert.equal(succeeded.phase, "succeeded");
  assert.equal(succeeded.phase === "succeeded" && succeeded.explorerUrl, "https://suiscan.xyz/mainnet/tx/Dg");
  const failed = done({ status: "failed", explorerUrl: null, message: "The launch aborted the purchase." });
  assert.equal(failed.phase === "failed" && failed.stage, "execution");
  assert.equal(failed.phase === "failed" && failed.digest, "Dg");
  const pending = done({ status: "pending", reason: "evidence-missing", message: "No purchase event." });
  assert.equal(pending.phase === "ambiguous" && pending.reason, "evidence-missing");
});

test("material facts compare by key, including added and removed facts", () => {
  assert.deepEqual(
    diffMaterialFacts(
      [{ key: "a", label: "A", value: "1" }, { key: "b", label: "B", value: "2" }],
      [{ key: "a", label: "A", value: "1" }, { key: "c", label: "C", value: "3" }],
    ),
    [
      { key: "c", label: "C", before: null, after: "3" },
      { key: "b", label: "B", before: "2", after: null },
    ],
  );
});

test("the published state fixtures reach every phase through the reducer", () => {
  const fixtures = actionStateFixtures();
  const phases: ActionPhase[] = [
    "editing",
    "choosing-signer",
    "connecting",
    "preflighting",
    "blocked",
    "review",
    "signing",
    "rejected",
    "reconciling",
    "succeeded",
    "failed",
    "ambiguous",
  ];
  assert.deepEqual(Object.keys(fixtures).sort(), [...phases].sort());
  for (const phase of phases) assert.equal(fixtures[phase].phase, phase);
});
