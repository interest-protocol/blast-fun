import assert from "node:assert/strict";
import test from "node:test";
import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";

import { configuredSigningChain } from "@blast/core/modules/launchpad-coin/signing-chain.ts";

import { serverOpeningAvailability, serverTradeAvailability } from "./server-availability.ts";

const released = { network: "mainnet", deployment: deploymentFingerprint(BLAST_DEPLOYMENTS.mainnet!) } as const;
const signingChain = configuredSigningChain({ BLAST_NETWORK: "mainnet" });

test("a released matching deployment enables coin trading only for an allowed request", () => {
  const config = { expectedDeployment: released, signingChain };
  assert.equal(serverTradeAvailability(config, true).status, "available");
  assert.equal(serverTradeAvailability(config, false).status, "unavailable");
  assert.equal(
    serverTradeAvailability({ ...config, expectedDeployment: { ...released, deployment: "a".repeat(64) } }, true).status,
    "unavailable",
  );
});

// An incomplete deployment pair now fails at parse (web-config.test.ts), so
// the "not configured correctly" answer is gone.
test("without a released, connected deployment the public coin page offers no trading, and says why", () => {
  for (const config of [
    { expectedDeployment: null, signingChain: null },
    { expectedDeployment: { ...released, deployment: "a".repeat(64) }, signingChain },
  ]) {
    const availability = serverTradeAvailability(config);
    assert.equal(availability.status, "unavailable");
    assert.match(availability.status === "unavailable" ? availability.reason : "", /released Blast deployment/);
  }
});

test("the same refusal names the action it closes", () => {
  assert.match(serverOpeningAvailability("Joining the opening round").reason, /^Joining the opening round is not enabled/);
});
