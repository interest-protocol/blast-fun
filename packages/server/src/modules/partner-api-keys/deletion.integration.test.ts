import { recognitionFixture } from "../../../test/fixtures/partner-recognition.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { urlAs, ROLES } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { createAdminPartnerKeyRoute, partnerKeyAdminPorts } from "@blast/server/modules/partner-api-keys/admin-route.ts";
import { createPartner, issuePartnerApiKey, revokePartnerApiKey, deleteRevokedPartnerKey, deleteInactivePartnerGroup, listPartnerApiKeys, createPartnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const BY = "operator:admin-console";
test("runtime deletion protects active credentials, serializes issuance and retains immutable receipts", {
  skip: databaseUrl && process.env.BLAST_TEST_REDIS_URL ? false : "Disposable PostgreSQL and Redis are required",
}, async (context) => {
  context.after(recognitionFixture(["retained", "delete-me", "issue-first", "delete-first"]));
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const webA = createPool(urlAs(databaseUrl, "blast_web"), { max: 1 });
  const webB = createPool(urlAs(databaseUrl, "blast_web"), { max: 1 });
  try {
    assert.ok((await migrateDatabase(admin)).includes("0129_partner_admin_deletion"));
    assert.deepEqual(await migrateDatabase(admin), []);
    const seed = async (id: string) => {
      await createPartner(webA, { id, origins: [] }, BY);
      return issuePartnerApiKey(webA, id, "Backend", BY);
    };
    const retained = await seed("retained");
    const key = await seed("delete-me");
    const route = createAdminPartnerKeyRoute(partnerKeyAdminPorts(() => webA));
    const call = (action: string, id: string) => route(new Request("https://blast.fun/api/admin/partner-keys", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id }),
    }));
    await context.test("active key and group deletion are conflicts, with no partial removal", async () => {
      for (const [action, id] of [["delete-key", key.id], ["delete-partner", "delete-me"]]) {
        assert.equal((await call(action, id)).status, 409);
      }
      assert.ok(await createPartnerKeyReader(() => webB).verify(key.key));
      assert.equal((await webB.query("SELECT count(*)::int AS n FROM partner_api_key_policy_events WHERE key_id=$1", [key.id])).rows[0].n, 1);
    });
    await context.test("revoked key deletion removes only its target, with exact confirmation and an immutable receipt", async () => {
      await revokePartnerApiKey(webA, key.id, BY);
      const response = await call("delete-key", key.id);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deletedKeyId: key.id });
      assert.equal((await call("delete-key", key.id)).status, 404);
      assert.equal(await createPartnerKeyReader(() => webB).verify(key.key), null);
      assert.equal((await webB.query("SELECT count(*)::int AS n FROM partner_api_key_policy_events WHERE key_id=$1", [key.id])).rows[0].n, 0);
      const receipt = await webB.query("SELECT object_type,target_id,partner_id,deleted_key_count,deleted_by FROM partner_api_deletion_events");
      assert.deepEqual(receipt.rows, [{ object_type: "key", target_id: key.id, partner_id: "delete-me", deleted_key_count: 1, deleted_by: BY }]);
      for (const table of ["partner_api_deletion_events", "partner_api_keys", "partner_api_partners", "partner_api_key_policy_events"])
        await assert.rejects(webA.query(`DELETE FROM ${table} WHERE false`), { code: "42501" });
      await assert.rejects(webA.query("UPDATE partner_api_deletion_events SET deleted_by=$1", [BY]), { code: "42501" });
      await assert.rejects(webA.query("INSERT INTO partner_api_deletion_events(object_type,target_id,partner_id,deleted_key_count,deleted_by) VALUES ('key','fake','fake',1,$1)", [BY]), { code: "42501" });
      for (const role of ROLES.filter((role) => role !== "blast_web")) {
        assert.equal((await admin.query("SELECT has_function_privilege($1,'partner_delete_revoked_key(uuid,text)','EXECUTE') AS allowed", [role])).rows[0].allowed, false);
      }
    });
    await context.test("group deletion handles empty groups and all revoked children, preserving unrelated live keys", async () => {
      const revoked = await issuePartnerApiKey(webA, "delete-me", "Old", BY);
      await revokePartnerApiKey(webA, revoked.id, BY);
      assert.deepEqual(await (await call("delete-partner", "delete-me")).json(), { deletedPartnerId: "delete-me" });
      assert.equal(await deleteInactivePartnerGroup(webA, "delete-me", BY), false);
      await createPartner(webA, { id: "delete-me", origins: [] }, BY);
      assert.equal(await deleteInactivePartnerGroup(webA, "delete-me", BY), true);
      assert.ok(await createPartnerKeyReader(() => webB).verify(retained.key));
      assert.deepEqual((await listPartnerApiKeys(webB)).partners.map((p) => p.id), ["retained"]);
      await assert.rejects(deleteRevokedPartnerKey(webA, retained.id, "invalid-actor"));
    });
    const waitForLock = async (sql: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1", [`%${sql}%`])).rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Expected concurrent operation to wait for the group lock");
    };
    await context.test("issuance that holds the FK lock makes deletion reject the newly active key", async () => {
      await createPartner(webA, { id: "issue-first", origins: [] }, BY);
      const writer = await webB.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'issue-first','Concurrent',$2,$3)", [randomUUID(), Buffer.alloc(32, 5), BY]);
        const rejected = assert.rejects(deleteInactivePartnerGroup(webA, "issue-first", BY), { code: "23514", constraint: "partner_deletion_requires_revocation" });
        await waitForLock("partner_delete_inactive_group");
        await writer.query("COMMIT");
        await rejected;
      } finally { await writer.query("ROLLBACK"); writer.release(); }
    });
    await context.test("deletion that holds the parent lock makes concurrent issuance reject the missing group", async () => {
      await createPartner(webA, { id: "delete-first", origins: [] }, BY);
      const writer = await webA.connect();
      try {
        await writer.query("BEGIN");
        assert.equal((await writer.query("SELECT partner_delete_inactive_group('delete-first',$1) AS deleted", [BY])).rows[0].deleted, true);
        const rejected = assert.rejects(issuePartnerApiKey(webB, "delete-first", "Concurrent", BY), { code: "23503" });
        await waitForLock("INSERT INTO partner_api_keys");
        await writer.query("COMMIT");
        await rejected;
      } finally { await writer.query("ROLLBACK"); writer.release(); }
    });
    await context.test("deletion migration rolls back and reapplies without changing surviving keys", async () => {
      const base = new URL("../../../../core/src/modules/database/migrations/", import.meta.url);
      for (const direction of ["down", "up"]) await admin.query(await readFile(new URL(`0129_partner_admin_deletion.${direction}.sql`, base), "utf8"));
      assert.ok(await createPartnerKeyReader(() => webB).verify(retained.key));
    });
  } finally { await webA.end(); await webB.end(); await admin.end(); }
});
