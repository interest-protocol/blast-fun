import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { createActionController, type ActionController, type SignerSource } from "../transaction/controller.ts";
import { fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { curveTradeAdapter, type CurveTradeInput } from "./curve-adapter.ts";

import { watchCurveTrades } from "./curve-trade-provider-model.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);

function setup() {
  const fixture = createTradeFixtureChain();
  const signer = fixtureWalletSigner();
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };
  const make = (direction: "buy" | "sell") =>
    createActionController({
      adapter: curveTradeAdapter(direction),
      chain,
      signers,
      input: { launchId: TRADE_LAUNCH_ID, direction, amount: "10", slippageBps: 100n } satisfies CurveTradeInput,
    });
  return { fixture, controllers: { buy: make("buy"), sell: make("sell") } };
}

async function until(controller: ActionController<CurveTradeInput>, test: (phase: string) => boolean) {
  for (let turn = 0; turn < 300 && !test(controller.getState().phase); turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("balances and the curve are read again when a review opens, when it is replaced, and when the preflight refuses", async () => {
  const { fixture, controllers } = setup();
  let refreshes = 0;
  const stop = watchCurveTrades(controllers, { deployment, report: () => {}, refresh: () => void (refreshes += 1), onCompleted: () => {} });
  controllers.buy.submit();
  await until(controllers.buy, (phase) => phase === "review");
  assert.equal(refreshes, 1, "review opened");
  const first = controllers.buy.getState();
  fixture.competingBuy(500_000_000_000n);
  if (first.phase === "review") controllers.buy.approve(first.review.id);
  await until(controllers.buy, (phase) => phase === "review" && controllers.buy.getState() !== first);
  const replaced = controllers.buy.getState();
  assert.ok(replaced.phase === "review" && first.phase === "review" && replaced.review.id !== first.review.id);
  assert.equal(refreshes, 2, "review replaced");
  controllers.buy.cancel();
  controllers.buy.edit({ ...controllers.buy.getState().input, amount: "1000" });
  controllers.buy.submit();
  await until(controllers.buy, (phase) => phase === "blocked");
  assert.equal(controllers.buy.getState().phase, "blocked");
  assert.equal(refreshes, 3, "preflight refused");
  stop();
  assert.equal(fixture.calls.execute, 0);
});

test("a reporter that throws never stops a trade: it completes once and the completion is still handed on", async () => {
  const { fixture, controllers } = setup();
  let reports = 0;
  const completions: string[] = [];
  const stop = watchCurveTrades(controllers, {
    deployment,
    report: () => {
      reports += 1;
      throw new Error("analytics down");
    },
    refresh: () => {},
    onCompleted: (direction, state, _latency, reportSafely) => {
      completions.push(`${direction}:${state.digest}`);
      reportSafely({ name: "curve_completed" } as never);
    },
  });
  controllers.buy.submit();
  await until(controllers.buy, (phase) => phase === "review");
  const review = controllers.buy.getState();
  if (review.phase === "review") controllers.buy.approve(review.review.id);
  await until(controllers.buy, (phase) => phase === "succeeded");
  assert.equal(controllers.buy.getState().phase, "succeeded");
  assert.equal(fixture.calls.execute, 1);
  assert.equal(completions.length, 1);
  assert.ok(reports >= 3, `reports attempted: ${reports}`);
  stop();
});
