import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import type { ActionState } from "../transaction/action-machine.ts";
import { actionStateFixtures } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { VenueTradeInput } from "./venue-adapter.ts";
import { BLUEFIN_LAUNCH_ID, VENUE_FIXTURE_MANIFEST } from "../../../../test/fixtures/launchpad/trade/venue-fixtures.ts";
import { venueGuidance, venueProblem } from "./venue-session.ts";

const INPUT: VenueTradeInput = { launchId: BLUEFIN_LAUNCH_ID, migrationDigest: null, poolKey: null, direction: "buy", amount: "10", slippageBps: 100n };
const states = actionStateFixtures(INPUT);
const deployment = defineBlastDeployment(VENUE_FIXTURE_MANIFEST);
const BLUEFIN_ORIGINAL = deployment.packages.bluefinSpot!.originalPackageId;
const BLUEFIN_PACKAGE = deployment.packages.bluefinSpot!.packageId;

/** Sui's wording of a Move abort, as the client reports it. */
const abort = (code: number, location: string) => `MoveAbort in 3rd command, abort code: ${code}, in '${location}' (instruction 51)`;
const simulationRefused = (message: string): ActionState<VenueTradeInput> => ({
  phase: "blocked",
  input: INPUT,
  attempt: 2,
  block: { stage: "simulation", code: "simulation-failed", message: `Sui rejected this transaction in simulation: ${message} Nothing was signed.`, details: [] },
});
const failedOnChain = (message: string) =>
  ({ ...states.failed, stage: "execution", message: `The transaction failed on Sui: ${message} Its changes were reverted; only network fees were spent.` }) as ActionState<VenueTradeInput>;

test("Bluefin's slippage_exceeds, in simulation or on chain, says the pool moved past the minimum and to quote again", () => {
  for (const location of [`${BLUEFIN_ORIGINAL}::pool::swap`, `${BLUEFIN_PACKAGE}::pool::swap`]) {
    const simulated = simulationRefused(abort(1010, location));
    assert.deepEqual(venueGuidance(simulated, deployment), {
      action: "refresh",
      text: "The Bluefin pool moved past your slippage tolerance after the quote, so it would pay less than the fewest you accept. Nothing was signed. Review again for a fresh quote, or allow more slippage.",
    });
    assert.equal(venueProblem(simulated, deployment), "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed.");
    const executed = failedOnChain(abort(1010, location));
    assert.equal(venueGuidance(executed, deployment)?.action, "refresh");
    assert.match(venueGuidance(executed, deployment)?.text ?? "", /^The Bluefin pool moved past your slippage tolerance .* Nothing changed hands\./);
    assert.equal(venueProblem(executed, deployment), "The swap failed on Sui: the Bluefin pool paid less than the fewest you accept, so it was reverted. Only network fees were spent.");
  }
});

test("a venue failure never shows a raw Move abort; an abort from another package is not read as Bluefin's", () => {
  const foreign = abort(1010, `0x${"ab".repeat(32)}::pool::swap`);
  const framework = abort(2, "0x0000000000000000000000000000000000000000000000000000000000000002::balance::split");
  for (const state of [simulationRefused(foreign), simulationRefused(framework), failedOnChain(foreign), failedOnChain(framework)]) {
    const problem = venueProblem(state, deployment) ?? "";
    assert.doesNotMatch(problem, /MoveAbort|abort code|0x[0-9a-f]{8}/i);
    assert.match(problem, /Sui refused this swap in simulation\. Nothing was signed\.|The swap failed on Sui and was reverted\. Only network fees were spent\./);
    assert.doesNotMatch(venueGuidance(state, deployment)?.text ?? "", /Bluefin/);
  }
  // Messages without an abort are shown as they are.
  assert.equal(venueProblem(states.blocked as ActionState<VenueTradeInput>, deployment), "Your wallet is set to Sui testnet. Switch it to Sui mainnet, then review again.");
  assert.equal(venueProblem(states.editing as ActionState<VenueTradeInput>, deployment), null);
});
