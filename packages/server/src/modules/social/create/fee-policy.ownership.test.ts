import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { PresaleClient } from "@interest-protocol/blast-sdk/presale";
import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createAfterResponseScheduler, createRequestWork, runWithRequestWork, trackRequestWork } from "@blast/server/lib/request-work.ts";
import { feePolicySource } from "./chain.ts";

test("fee-policy fallback keeps the original SDK read owned after its visible timeout", async () => {
  let reject!: (error: Error) => void;
  const actual = new Promise<never>((_resolve, fail) => { reject = fail; });
  const sdk = mock.method(PresaleClient.prototype, "getFeePolicy", () => actual);
  const identity = { ...parsePresaleRuntimeIdentity(presaleIdentityFixture(), { production: false }), network: "mainnet" as const };
  const scope = createRequestWork(createAfterResponseScheduler());
  const read = feePolicySource({ state: { status: "ready", identity }, client: () => ({} as NonNullable<ReturnType<Parameters<typeof feePolicySource>[0]["client"]>>), configured: CREATE_DEFAULT_FEE_POLICY, timeoutMs: 10, trackWork: trackRequestWork });
  try {
    assert.deepEqual(await runWithRequestWork(scope, read), CREATE_DEFAULT_FEE_POLICY);
    let completed = false;
    const finishing = scope.complete().then(() => { completed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false, "fallback does not release the still-running SDK read");
    reject(new Error("synthetic provider completed"));
    await finishing;
    assert.equal(completed, true);
    assert.equal(sdk.mock.callCount(), 1);
  } finally { reject(new Error("fixture cleanup")); await scope.complete(); sdk.mock.restore(); }
});
