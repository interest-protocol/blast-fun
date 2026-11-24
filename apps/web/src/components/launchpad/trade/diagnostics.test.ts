import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { createActionController, type SignerSource } from "../transaction/controller.ts";
import { actionStateFixtures, fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { readCompletedTrade } from "./completed-trade.ts";
import { curveTradeAdapter, type CurveTradeInput } from "./curve-adapter.ts";
import { completionDiagnostics, curveDiagnostics, tradeLedger } from "./diagnostics.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const INPUT: CurveTradeInput = { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "10", slippageBps: 100n };

function memoryLedger(values = new Map<string, string>()) {
  return tradeLedger(() => ({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }));
}

test("the funnel steps come from the shared action states, with no amounts, addresses, or digests", () => {
  const states = actionStateFixtures(INPUT);
  const at = (from: keyof typeof states, to: keyof typeof states) => curveDiagnostics(states[from], states[to], "buy");
  assert.deepEqual(at("preflighting", "review"), [{ event: "curve_review_shown", direction: "buy" }]);
  assert.deepEqual(at("review", "signing"), [{ event: "curve_signature_requested", direction: "buy" }]);
  assert.deepEqual(at("review", "editing"), [{ event: "curve_review_abandoned", direction: "buy" }]);
  assert.deepEqual(at("signing", "rejected"), [{ event: "curve_rejected", direction: "buy" }]);
  assert.deepEqual(at("preflighting", "blocked"), [{ event: "curve_failed", direction: "buy", stage: "preflight", reason: "wrong-network" }]);
  assert.deepEqual(at("reconciling", "failed"), [{ event: "curve_failed", direction: "buy", stage: "execution", reason: "execution" }]);
  // Intent and success are not counted here: completion waits for the completed event (completionDiagnostics).
  assert.deepEqual(at("editing", "preflighting"), []);
  assert.deepEqual(at("reconciling", "succeeded"), []);
  for (const diagnostics of Object.values(states).map((state) => curveDiagnostics(null, state, "buy"))) assert.deepEqual(diagnostics, []);
});

test("an on-chain failure names its cause from the contract's abort code", () => {
  const states = actionStateFixtures(INPUT);
  const failed = (message: string) => ({ ...states.failed, message }) as typeof states.failed;
  const reason = (message: string) => curveDiagnostics(states.reconciling, failed(message), "sell", deployment)[0];
  const launchpad = deployment.packages.launchpad.packageId;
  assert.deepEqual(reason(`MoveAbort in 2nd command, abort code: 13, in '${launchpad}::launch::sell' (instruction 12)`), {
    event: "curve_failed",
    direction: "sell",
    stage: "execution",
    reason: "slippage",
  });
  assert.equal((reason(`MoveAbort in 2nd command, abort code: 12, in '${launchpad}::launch::buy' (instruction 3)`) as { reason: string }).reason, "lifecycle");
  assert.equal((reason(`MoveAbort in 2nd command, abort code: 14, in '${launchpad}::launch::buy' (instruction 3)`) as { reason: string }).reason, "zero-output");
  assert.equal((reason(`MoveAbort in 2nd command, abort code: 16, in '${launchpad}::launch::buy' (instruction 3)`) as { reason: string }).reason, "execution");
  assert.equal((reason(`MoveAbort in 2nd command, abort code: 99, in '${launchpad}::launch::buy' (instruction 3)`) as { reason: string }).reason, "execution");
  // The same code from another package, or from another launchpad module, is not the curve's slippage.
  assert.equal((reason(`MoveAbort in 2nd command, abort code: 13, in '0x${"ab".repeat(32)}::other::f' (instruction 3)`) as { reason: string }).reason, "execution");
  assert.equal((reason(`MoveAbort in 2nd command, abort code: 13, in '${launchpad}::allocation::plan' (instruction 3)`) as { reason: string }).reason, "execution");
});

async function completedBuy() {
  const fixture = createTradeFixtureChain();
  const signer = fixtureWalletSigner();
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const controller = createActionController({
    adapter: curveTradeAdapter("buy"),
    chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" },
    signers,
    input: INPUT,
  });
  controller.submit();
  for (let turn = 0; turn < 300 && controller.getState().phase !== "review"; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const review = controller.getState();
  if (review.phase === "review") controller.approve(review.review.id);
  for (let turn = 0; turn < 300 && controller.getState().phase !== "succeeded"; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const done = controller.getState();
  assert.equal(done.phase, "succeeded");
  return { fixture, done: done as Extract<typeof done, { phase: "succeeded" }> };
}

test("a completed buy reads its Bought event; completion and conversion are reported once per digest", async () => {
  const { fixture, done } = await completedBuy();
  const trade = await readCompletedTrade(fixture.client, deployment, done.digest);
  assert.equal(trade.status, "ok");
  if (trade.status !== "ok") return;
  assert.equal(trade.trade.kind, "Bought");
  const ledger = memoryLedger();
  const report = () =>
    completionDiagnostics({ direction: "buy", launchId: TRADE_LAUNCH_ID, digest: done.digest, facts: done.review.facts, decimals: 9, trade: trade.trade, latencyMs: 3_200, ledger });
  assert.deepEqual(report(), [
    { event: "curve_completed", direction: "buy", latency: "2-5s", delta: "exact", repeat: "first" },
    { event: "curve_conversion" },
  ]);
  assert.deepEqual(report(), []);
});

test("a sale completes without counting a conversion, and a later trade on the same launch is a repeat", async () => {
  const { fixture, done } = await completedBuy();
  const trade = await readCompletedTrade(fixture.client, deployment, done.digest);
  if (trade.status !== "ok") return assert.fail("no trade");
  const ledger = memoryLedger();
  completionDiagnostics({ direction: "buy", launchId: TRADE_LAUNCH_ID, digest: done.digest, facts: done.review.facts, decimals: 9, trade: trade.trade, latencyMs: 900, ledger });
  const sold = { kind: "Sold" as const, quoteOutNet: 1n, memeIn: 1n };
  assert.deepEqual(
    completionDiagnostics({ direction: "sell", launchId: TRADE_LAUNCH_ID, digest: "Other111111111111111111111111111111", facts: [], decimals: 9, trade: sold, latencyMs: 20_000, ledger }),
    [{ event: "curve_completed", direction: "sell", latency: ">15s", delta: "unknown", repeat: "repeat" }],
  );
});

test("a completed transaction without the expected event is never a completion or a conversion", () => {
  const ledger = memoryLedger();
  assert.deepEqual(
    completionDiagnostics({ direction: "buy", launchId: TRADE_LAUNCH_ID, digest: "X", facts: [], decimals: 9, trade: null, latencyMs: 1, ledger }),
    [],
  );
});
