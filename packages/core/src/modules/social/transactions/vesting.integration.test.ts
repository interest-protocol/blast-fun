import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import { migrateDatabase } from "../../database/migrations.ts";

const connectionString = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = connectionString
  ? false
  : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

test(
  "vesting attempts bind immutable transaction facts and attach a public schedule once",
  { skip },
  async (t) => {
    const pool = new Pool({ connectionString, max: 1 });
    t.after(() => pool.end());
    await migrateDatabase(pool);
    const client = await pool.connect();
    const account = randomUUID(),
      request = randomUUID();
    const address = `0x${"1".repeat(64)}`;
    const digest = "1".repeat(43);
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO social_accounts(account_id,privy_did,callsign,display_name) VALUES($1,$2,$3,'Vesting test')",
        [
          account,
          `did:privy:${account}`,
          `v${account.replaceAll("-", "").slice(0, 12)}`,
        ],
      );
      await client.query(
        "INSERT INTO social_transactions(tx_id,account_id,kind,digest,idempotency_key) VALUES($1,$2,'vesting_create',$3,$4)",
        [request, account, digest, `vesting:${request}`],
      );
      await client.query(
        "INSERT INTO social_vesting_attempts VALUES($1,$2,$3,$4,'reviewed-bytes',$5,'10000000',9999999999999,NULL)",
        [request, account, address, { action: "create" }, digest],
      );
      for (const field of [
        "transaction_bytes",
        "digest",
        "sender",
        "intent",
        "expires_at_ms",
        "gas_budget",
        "account_id",
        "sponsor_reservation_id",
      ]) {
        await client.query("SAVEPOINT immutable_probe");
        const expression =
          field === "intent"
            ? "'{}'::jsonb"
            : field === "expires_at_ms"
              ? "0"
              : field === "account_id" || field === "sponsor_reservation_id"
                ? "gen_random_uuid()"
                : "'changed'";
        await assert.rejects(
          client.query(
            `UPDATE social_vesting_attempts SET ${field}=${expression} WHERE request_id=$1`,
            [request],
          ),
          /immutable/,
        );
        await client.query("ROLLBACK TO SAVEPOINT immutable_probe");
      }
      await client.query(
        "UPDATE social_vesting_attempts SET schedule_id=$2 WHERE request_id=$1",
        [request, address],
      );
      await client.query("SAVEPOINT schedule_probe");
      await assert.rejects(
        client.query(
          "UPDATE social_vesting_attempts SET schedule_id=NULL WHERE request_id=$1",
          [request],
        ),
        /immutable/,
      );
      await client.query("ROLLBACK TO SAVEPOINT schedule_probe");
      assert.equal(
        (
          await client.query(
            "SELECT schedule_id FROM social_vesting_attempts WHERE request_id=$1",
            [request],
          )
        ).rows[0].schedule_id,
        address,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
