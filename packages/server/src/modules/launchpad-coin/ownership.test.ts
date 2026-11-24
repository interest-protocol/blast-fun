import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { createAfterResponseScheduler, createRequestWork, runWithRequestWork, trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createCompletedEventVerifier } from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { createLaunchpadTelemetryEmitter, type LaunchpadTelemetrySink } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import { createFreshLaunchReader } from "./fresh.ts";
import { COIN_FIXTURE, fixtureCoreClient, launchObjectFixture } from "../../../../core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { NON_PRODUCTION_MANIFEST } from "../../../../core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";

async function assertRetained(scope: ReturnType<typeof createRequestWork>, release: () => void) {
  let finished = false;
  const completing = scope.complete().then(() => { finished = true; });
  await pause(10);
  assert.equal(finished, false, "Visible timeout must retain actual work ownership");
  release();
  await completing;
  assert.equal(finished, true);
}

test("telemetry visible deadline keeps the actual storage operation owned until settlement", async () => {
  const pending = Promise.withResolvers<"recorded">();
  const sink: LaunchpadTelemetrySink = {
    admitCoinView: async () => "allowed", admitOutcomeReport: async () => "allowed", admitOutcomeCommitment: async () => "allowed",
    recordCoinView: () => pending.promise, recordOutcome: () => pending.promise, recordOutcomeCommitment: () => pending.promise,
  };
  const emitter = createLaunchpadTelemetryEmitter(() => sink, { timeoutMs: 5, trackWork: trackRequestWork });
  const scope = createRequestWork(createAfterResponseScheduler());
  assert.equal(await runWithRequestWork(scope, () => emitter.recordCoinView("synthetic", {})), "dropped");
  await assertRetained(scope, () => pending.resolve("recorded"));
});

test("fresh SDK read keeps ignored abort work owned after its visible deadline", async () => {
  const pending = Promise.withResolvers<void>();
  const reader = createFreshLaunchReader({
    manifest: NON_PRODUCTION_MANIFEST,
    client: fixtureCoreClient(async () => { await pending.promise; return launchObjectFixture("live"); }),
  }, Date.now, { timeoutMs: 5, trackWork: trackRequestWork });
  const scope = createRequestWork(createAfterResponseScheduler());
  assert.equal((await runWithRequestWork(scope, () => reader(COIN_FIXTURE.launchId))).status, "unavailable");
  await assertRetained(scope, () => pending.resolve());
});

test("completed-event provider concurrency survives timeout and recovers only after actual settlement", async () => {
  const pending = Promise.withResolvers<void>();
  let reads = 0;
  const verify = createCompletedEventVerifier({
    configured: async () => true,
    source: () => ({
      client: { core: {
        getChainIdentifier: async () => { reads++; await pending.promise; throw new Error("Synthetic provider failure"); },
        getTransaction: async () => { throw new Error("Must not reach a transaction"); },
      } },
      chainIdentifier: "synthetic", originalPackageId: "synthetic",
    }),
    match: () => ({ reason: "synthetic-refusal" }),
    timeoutMs: 5, maxConcurrent: 1, trackWork: trackRequestWork,
  });
  const scope = createRequestWork(createAfterResponseScheduler());
  assert.deepEqual(await runWithRequestWork(scope, () => verify({ txDigest: "synthetic" })), { status: "unavailable", reason: "node-unavailable" });
  assert.deepEqual(await verify({ txDigest: "synthetic" }), { status: "unavailable", reason: "node-busy" });
  assert.equal(reads, 1);
  await assertRetained(scope, () => pending.resolve());
  const next = createRequestWork(createAfterResponseScheduler());
  await runWithRequestWork(next, () => verify({ txDigest: "synthetic" }));
  await next.complete();
  assert.equal(reads, 2);
});
