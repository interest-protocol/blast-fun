import assert from "node:assert/strict";
import test from "node:test";
import { adminPool, freshDatabase, DEPLOYMENT } from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { parseFeeClaimIntents } from "./job.ts";
const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("launch fee job refuses a durable vault claim from the removed stack", () => {
  assert.throws(() => parseFeeClaimIntents({ records: [{ kind: "vault", vaultId: "0x1" }] }));
});
test("launch fee cadence has no vault collection ownership", { skip: !url }, async () => {
  const database = await freshDatabase();
  const admin = adminPool(database.url);
  try {
    const result = await admin.query("SELECT count(*)::int AS count FROM mission_control_fee_claims WHERE network=$1", [DEPLOYMENT.network]);
    assert.equal(result.rows[0].count, 0);
  } finally { await admin.end(); await database.drop(); }
});
