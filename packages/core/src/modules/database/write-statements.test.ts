import assert from "node:assert/strict";
import test from "node:test";

import { assertOwnedWriteStatement, ownedWriteTarget } from "./transaction.ts";

test("owned writes accept quoted ORM identifiers and reject other targets", () => {
  const table = "mission_control_worker_leases";
  for (const statement of [
    `INSERT INTO "${table}" (job) VALUES ($1)`,
    `UPDATE "${table}" SET job = $1`,
    `DELETE FROM "${table}" WHERE job = $1`,
    `INSERT INTO ${table}(job) VALUES ($1)`,
  ]) {
    assertOwnedWriteStatement("worker-runtime", table, statement);
    assert.equal(ownedWriteTarget("worker-runtime", statement), table);
  }
  for (const statement of [
    'UPDATE "social_accounts" SET account_id = $1',
    `UPDATE "${table}".other SET job = $1`,
    `UPDATE "${table}_other" SET job = $1`,
    `UPDATE "${table} SET job = $1`,
    `UPDATE "public"."${table}" SET job = $1`,
    `UPDATE "${table}" SET job = $1; DELETE FROM social_accounts`,
  ]) {
    assert.throws(() => assertOwnedWriteStatement("worker-runtime", table, statement));
    assert.throws(() => ownedWriteTarget("worker-runtime", statement));
  }
});
