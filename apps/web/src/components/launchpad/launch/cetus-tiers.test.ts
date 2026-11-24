import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { readCetusFees } from "./cetus-tiers.ts";
import { createLaunchFixtureChain, LAUNCH_FIXTURE_MANIFEST } from "../../../../test/fixtures/launchpad/launch/launch-fixtures.ts";

test("the recorded Cetus GlobalConfig is read from the node", async () => {
  const deployment = defineBlastDeployment(LAUNCH_FIXTURE_MANIFEST);
  const fixture = createLaunchFixtureChain({ cetusTiers: { "60": "2500" } });
  assert.deepEqual(await readCetusFees(fixture.client, deployment), { "60": "2500" });
  fixture.state.venueObjects.cetus = "mismatch";
  await assert.rejects(readCetusFees(fixture.client, deployment), /not the recorded Cetus GlobalConfig/);
});
