import assert from "node:assert/strict";
import test from "node:test";
import { HEALTH_STALE_MS, serviceHealthSchema } from "@blast/core/modules/service-health/contracts.ts";
import { readServiceHealth } from "./read.ts";

const now = 1_800_000_000_000;
const checkpoint = "9007199254740993";
const healthy = {
  backend: async () => "healthy" as const,
  sui: async () => ({ checkpoint, timestampMs: now - 1_000 }),
  now: () => now,
};

test("independent probes preserve checkpoint precision and require recent chain time", async () => {
  const result = await readServiceHealth(healthy);
  assert.equal(result.backend, "healthy");
  assert.equal(result.sui.status, "healthy");
  assert.equal(result.sui.checkpoint, checkpoint);
  assert.deepEqual(serviceHealthSchema.parse(result), result);

  for (const age of [HEALTH_STALE_MS, HEALTH_STALE_MS + 1]) {
    const result = await readServiceHealth({ ...healthy, sui: async () => ({ checkpoint, timestampMs: now - age }) });
    assert.equal(result.sui.status, age === HEALTH_STALE_MS ? "healthy" : "stale");
  }
});

test("a healthy backend never masks a failed Sui probe, or vice versa", async () => {
  const fail = () => { throw new Error("private upstream detail"); };
  const suiDown = await readServiceHealth({ ...healthy, sui: fail });
  assert.equal(suiDown.backend, "healthy");
  assert.deepEqual(suiDown.sui, { status: "unavailable", checkpoint: null, timestampMs: null });
  const backendDown = await readServiceHealth({ ...healthy, backend: fail });
  assert.equal(backendDown.backend, "unavailable");
  assert.equal(backendDown.sui.status, "healthy");
  assert.equal((await readServiceHealth({ ...healthy, backend: async () => "degraded" })).backend, "degraded");
  assert.doesNotMatch(JSON.stringify([suiDown, backendDown]), /private upstream detail/);
});

test("invalid checkpoint responses cannot become healthy", async () => {
  for (const value of [
    { checkpoint: "-1", timestampMs: now },
    { checkpoint, timestampMs: 0 },
    { checkpoint, timestampMs: NaN },
    { checkpoint, timestampMs: now + 5_001 },
  ]) {
    assert.equal((await readServiceHealth({ ...healthy, sui: async () => value })).sui.status, "unavailable");
  }
});
