import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { NON_PRODUCTION_MANIFEST } from "../../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { LAUNCH_FIXTURE_MANIFEST } from "../../../../../test/fixtures/launchpad/launch/launch-fixtures.ts";
import { contractRejection, launchpadAbortOf } from "./contract-errors.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const LAUNCHPAD = deployment.packages.launchpad.packageId;

function simulated(code: number, module = "launch", pkg = LAUNCHPAD, fn = "finalize") {
  return `Sui rejected this transaction in simulation: MoveAbort in 4th command, abort code: ${code}, in '${pkg}::${module}::${fn}' (instruction 12) Nothing was signed.`;
}

test("a launchpad abort in simulation uses the current registry to name the constrained field", () => {
  assert.deepEqual(contractRejection(simulated(1, "launch_config"), deployment), {
    field: "decimals",
    message: "The contract refused this launch: Blast does not admit these decimals now (abort 1).",
  });
  assert.equal(contractRejection(simulated(2, "launch_config"), deployment)?.field, "venue");
  assert.equal(contractRejection(simulated(3, "launch_config"), deployment)?.field, "venue");
  assert.equal(contractRejection(simulated(5, "allocation"), deployment)?.field, "allocation.memeTotal");
  assert.equal(contractRejection(simulated(7), deployment)?.field, "sellBurn");
  assert.equal(contractRejection(simulated(10), deployment)?.field, "openingRound");
  assert.equal(contractRejection(simulated(11), deployment)?.field, "graduationTarget");
  assert.equal(contractRejection(simulated(13), deployment)?.field, "purchase.minMemeOut");
  assert.equal(contractRejection(simulated(14), deployment)?.field, "purchase.amount");
  assert.equal(contractRejection(simulated(20), deployment)?.field, "creator");
  assert.equal(contractRejection(simulated(21), deployment)?.field, "creator");
  assert.equal(contractRejection(simulated(27, "launch_config"), deployment)?.field, "quote");
  assert.equal(contractRejection(simulated(28), deployment)?.field, "virtualQuote");
  assert.equal(contractRejection(simulated(29), deployment)?.field, "purchase.amount");
});

test("aborts from other packages, unknown codes, or other failures point at no field", () => {
  assert.equal(contractRejection(simulated(1, "launch_config", `0x${"ab".repeat(32)}`), deployment), null);
  assert.equal(contractRejection(simulated(99), deployment), null);
  assert.equal(contractRejection(simulated(16), deployment), null);
  assert.equal(contractRejection(simulated(24, "allocation"), deployment), null);
  assert.equal(contractRejection(simulated(36, "launch_config"), deployment), null);
  assert.equal(contractRejection("Sui could not simulate this transaction right now.", deployment), null);
});

test("allocation errors retain function-specific guidance with the current registry", () => {
  const field = (code: number, fn: string) => contractRejection(simulated(code, "allocation", LAUNCHPAD, fn), deployment)?.field;
  assert.equal(field(5, "plan"), "allocation.curve");
  assert.equal(field(5, "add_protocol"), "allocation.memeTotal");
  assert.equal(field(6, "add_protocol"), "allocation.recipients");
  assert.equal(contractRejection(simulated(5, "launch", LAUNCHPAD, "plan"), deployment)?.field, "allocation.memeTotal");
  assert.match(contractRejection(simulated(5, "allocation", LAUNCHPAD, "plan"), deployment)?.message ?? "", /curve's or the pool's share/);
});

test("the shared abort parser reads only aborts raised by the accepted launchpad package", () => {
  assert.deepEqual(launchpadAbortOf(simulated(16, "launch", LAUNCHPAD, "buy"), deployment), { code: 16, module: "launch", functionName: "buy" });
  assert.equal(launchpadAbortOf(simulated(16, "launch", `0x${"ab".repeat(32)}`, "buy"), deployment), null);
  assert.equal(launchpadAbortOf("Sui rejected this transaction: InsufficientGas", deployment), null);
});

test("a Cetus CLMM abort while starting the launch points at the pool tier, only for the recorded Cetus package", () => {
  const withCetus = defineBlastDeployment(LAUNCH_FIXTURE_MANIFEST);
  const cetus = withCetus.packages.cetusClmm!;
  const refused = (pkg: string, module = "config", fn = "get_fee_rate") =>
    `Sui rejected this transaction in simulation: MoveAbort in 1st command, abort code: 2, in '${pkg}::${module}::${fn}' (instruction 9) Nothing was signed.`;
  const rejection = contractRejection(refused(cetus.packageId), withCetus);
  assert.equal(rejection?.field, "tier");
  assert.match(rejection?.message ?? "", /Cetus refused this pool tier: it does not register this tick spacing or refuses the pair at it \(abort 2 in config::get_fee_rate\)/);
  assert.equal(contractRejection(refused(cetus.originalPackageId, "factory", "register_permission_pair"), withCetus)?.field, "tier");
  assert.equal(contractRejection(refused(`0x${"ab".repeat(32)}`), withCetus), null);
  // Without a recorded Cetus set there is no Cetus package to attribute an abort to.
  assert.equal(contractRejection(refused(cetus.packageId), deployment), null);
});
