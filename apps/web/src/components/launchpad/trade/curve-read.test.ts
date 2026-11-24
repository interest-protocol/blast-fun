import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { readCurve } from "./curve-read.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID, TRADE_MEME_TYPE } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);

test("a curve read decodes the launch through the SDK and records what it observed", async () => {
  const fixture = createTradeFixtureChain();
  const read = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_123_000);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.equal(read.curve.launch.lifecycle, "Live");
  assert.equal(read.curve.launch.memeType, TRADE_MEME_TYPE);
  assert.equal(read.curve.launch.memeReserve, 690_000_000_000_000_000n);
  assert.equal(read.curve.decimals, 9);
  assert.equal(read.curve.symbol, "TOAD");
  assert.deepEqual(read.curve.observation, { version: "40", observedAtMs: 1_790_000_123_000 });
  fixture.competingBuy(1_000_000_000n);
  const later = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_124_000);
  assert.equal(later.status === "ok" && later.curve.observation.version, "41");
});

test("a missing launch, a foreign object, or a node that cannot answer is unavailable, never zero", async () => {
  const fixture = createTradeFixtureChain();
  assert.equal((await readCurve(fixture.client, deployment, `0x${"99".repeat(32)}`, 1)).status, "unavailable");
  assert.equal((await readCurve(fixture.client, deployment, deployment.sharedObjects.launchpad.launchConfig.objectId, 1)).status, "unavailable");
  fixture.state.reads = "unavailable";
  assert.equal((await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1)).status, "unavailable");
});
