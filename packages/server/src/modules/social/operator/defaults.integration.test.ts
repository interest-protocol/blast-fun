import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, migrateDatabase } from "@blast/core/modules/database/admin.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { defaultsSet } from "./defaults.ts";
import { runSocialOperatorInvocation } from "./framework.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("default account batches create missing member accounts, preserve order, and roll back an unknown callsign", {
  skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
}, async () => {
  assert.ok(databaseUrl);
  const pool = createPool(databaseUrl);
  const token = "defaults-integration-token-of-32-characters";
  const operator = new OperatorAuthenticator({ operatorId: "ops.defaults", tokenHash: createHash("sha256").update(token).digest("hex") }).authenticate("ops.defaults", token);
  const callsigns = ["crew_four", "crew_three", "crew_two", "crew_one"];
  const run = (names: string[]) => runSocialOperatorInvocation({ command: defaultsSet, input: { callsigns: names }, reason: null }, operator,
    (operation) => withTransaction(pool, operation));
  const configured = async () => (await pool.query(`SELECT i.callsign FROM social_default_accounts d
    JOIN social_account_identities i ON i.account_id = d.account_id ORDER BY d.position`)).rows.map((row) => row.callsign);
  try {
    await migrateDatabase(pool);
    for (const [index, callsign] of callsigns.entries()) {
      await pool.query(`INSERT INTO mission_control_profiles (
        profile_id, privy_did, x_subject, sui_address, provider_wallet_reference,
        callsign, disclosure_version, disclosure_accepted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'v1', now())`,
      [randomUUID(), `did:privy:defaults-${index}`, `defaults-${index}`, `0x${String(index + 1).padStart(64, "0")}`, `wallet-${index}`, callsign]);
    }
    await run(callsigns);
    assert.deepEqual(await configured(), callsigns);
    await run([...callsigns].reverse());
    assert.deepEqual(await configured(), [...callsigns].reverse());
    await assert.rejects(run(["crew_unknown", ...callsigns.slice(1)]), (error) => error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND");
    assert.deepEqual(await configured(), [...callsigns].reverse());
    assert.equal((await pool.query("SELECT count(*)::int AS total FROM social_accounts")).rows[0].total, 4);
  } finally {
    await pool.end();
  }
});
