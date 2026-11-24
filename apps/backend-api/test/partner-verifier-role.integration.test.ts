import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import {
  primaryPool,
  partnerVerifierPool,
  endPartnerVerifierPool,
} from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { endProcessPools } from "../../../packages/core/test/fixtures/modules/database/testing.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import {
  generatePartnerApiKey,
  hashPartnerApiKey,
} from "@blast/server/modules/partner-api-keys/contracts.ts";
import { partnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";

test(
  "dedicated verifier login reads fresh grants, cannot mutate authority or quotas, and stays separate from the writer pool",
  { timeout: 45_000 },
  async (t) => {
    const database = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
    assert.ok(database, "An owned disposable primary is mandatory; no skip.");
    assert.equal(new URL(database).hostname, "127.0.0.1");
    const admin = new Pool({ connectionString: database, max: 1 });
    t.after(() => admin.end());
    await migrateDatabase(admin);
    const verifierUrl = await partnerVerifierFixture(database, t);
    const environment = {
      DATABASE_URL: urlAs(database, "blast_web"),
      PARTNER_VERIFIER_DATABASE_URL: verifierUrl,
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    t.after(async () => {
      await endProcessPools();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
    const writer = primaryPool();
    assert.equal(writer.options.connectionString, environment.DATABASE_URL);
    const verifier = partnerVerifierPool();
    assert.equal(verifier.options.max, 2);
    assert.notEqual(verifier, writer);
    const identity = (
      await verifier.query(`SELECT current_user AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    FROM pg_roles WHERE rolname=current_user`)
    ).rows[0];
    assert.equal(identity.name, new URL(verifierUrl).username);
    for (const key of [
      "rolsuper",
      "rolbypassrls",
      "rolcreaterole",
      "rolcreatedb",
      "rolreplication",
    ]) {
      assert.equal(identity[key], false);
    }
    assert.deepEqual(
      (
        await verifier.query(`SELECT r.rolname FROM pg_roles r JOIN pg_auth_members m ON m.roleid=r.oid
    WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user) ORDER BY r.rolname`)
      ).rows,
      [{ rolname: "blast_partner_verifier" }],
    );
    assert.equal(
      (
        await verifier.query(
          `SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
        )
      ).rows[0].n,
      0,
    );
    const key = generatePartnerApiKey();
    const keyId = randomUUID();
    const partnerId = "verifier-" + randomUUID();
    const markerBefore = (await admin.query("SELECT * FROM partner_api_recognition")).rows;
    await writer.query(
      "INSERT INTO partner_api_partners(id,origins,created_by,updated_by) VALUES($1,$2,'operator:test','operator:test')",
      [partnerId, ["https://allowed.test"]],
    );
    await writer.query(
      "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES($1,$2,'Retained key',$3,'operator:test')",
      [keyId, partnerId, hashPartnerApiKey(key)],
    );
    const rowsBefore = (await admin.query("SELECT * FROM partner_api_keys WHERE id=$1", [keyId]))
      .rows;
    assert.equal((await partnerKeyReader.verify(key))?.keyId, keyId);
    assert.equal(await partnerKeyReader.allowsOrigin("https://allowed.test"), true);
    assert.equal(await partnerKeyReader.allowsOrigin("https://wrong.test"), false);
    const denied = [
      "SELECT label FROM partner_api_keys",
      "SELECT created_by FROM partner_api_partners",
      "INSERT INTO partner_api_partners(id,origins,created_by,updated_by) VALUES('forbidden','{}','operator:test','operator:test')",
      `UPDATE partner_api_partners SET origins='{}' WHERE id='${partnerId}'`,
      `DELETE FROM partner_api_partners WHERE id='${partnerId}'`,
      "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) SELECT id,partner_id,label,key_hash,issued_by FROM partner_api_keys",
      `UPDATE partner_api_keys SET revoked_at=now() WHERE id='${keyId}'`,
      `DELETE FROM partner_api_keys WHERE id='${keyId}'`,
      "SELECT * FROM partner_api_recognition",
      "UPDATE partner_api_recognition SET revision=revision+1",
      `INSERT INTO mission_control_rate_limit_windows(policy_name,policy_version,subject_hash,window_seconds,window_started_at,request_count,expires_at)
      VALUES('partner_read',1,repeat('0',64),60,date_trunc('minute',now()),1,date_trunc('minute',now())+interval '60 seconds')`,
      `UPDATE mission_control_rate_limit_windows SET request_count=1 WHERE policy_name='partner_read'`,
      `DELETE FROM mission_control_rate_limit_windows WHERE policy_name='partner_read'`,
      "SELECT * FROM social_wallet_sessions",
      "SELECT nextval('partner_api_key_policy_events_id_seq')",
      "SELECT public.partner_delete_revoked_key('00000000-0000-4000-8000-000000000000'::uuid,'operator:test')",
    ];
    for (const sql of denied) {
      await assert.rejects(verifier.query(sql), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "42501", sql);
        return true;
      });
    }
    assert.deepEqual(
      (await admin.query("SELECT * FROM partner_api_keys WHERE id=$1", [keyId])).rows,
      rowsBefore,
    );
    assert.deepEqual(
      (await admin.query("SELECT * FROM partner_api_recognition")).rows,
      markerBefore,
    );
    await writer.query(
      "UPDATE partner_api_keys SET revoked_at=now(),revoked_by='operator:test' WHERE id=$1",
      [keyId],
    );
    assert.equal(
      await partnerKeyReader.verify(key),
      null,
      "The next verification sees revocation immediately",
    );
    assert.equal(await partnerKeyReader.allowsOrigin("https://allowed.test"), false);
    const oldVerifier = verifier;
    await endPartnerVerifierPool();
    assert.notEqual(
      partnerVerifierPool(),
      oldVerifier,
      "Shutdown closes and forgets only the verifier pool",
    );
  },
);
