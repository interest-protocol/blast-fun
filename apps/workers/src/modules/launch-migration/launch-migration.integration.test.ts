import assert from "node:assert/strict";
import test from "node:test";
import { adminPool, freshDatabase, DEPLOYMENT, FINGERPRINT } from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { checkIndex } from "../worker-runtime/index-identity.ts";
const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("the index gate passes this deployment's committed checkpoint and blocks another network or deployment", { skip: !url }, async () => {
  const database = await freshDatabase(1234);
  const admin = adminPool(database.url);
  try {
    assert.deepEqual(await checkIndex(admin, DEPLOYMENT.network, FINGERPRINT), { blocked: null, checkpoint: "1234" });
    assert.deepEqual(await checkIndex(admin, DEPLOYMENT.network, "another-deployment"), { blocked: ["deployment-mismatch"] });
    assert.deepEqual(await checkIndex(admin, "testnet", FINGERPRINT), { blocked: ["wrong-network"] });
  } finally { await admin.end(); await database.drop(); }
});
