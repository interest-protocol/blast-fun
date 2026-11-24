import { recognitionFixture } from "../../../test/fixtures/partner-recognition.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { createPartner, createPartnerKeyReader, issuePartnerApiKey } from "@blast/server/modules/partner-api-keys/repository.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("fresh partner grant and preflight each need one database exchange", { skip: databaseUrl && process.env.BLAST_TEST_REDIS_URL ? false : "Disposable PostgreSQL and Redis required" }, async (context) => {
  context.after(recognitionFixture(["admission"]));
  assert.ok(databaseUrl);
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  const pool = createPool(databaseUrl, { max: 1 });
  try {
    await migrateDatabase(pool);
    await createPartner(pool, { id: "admission", origins: ["https://partner.example"] }, "operator:test");
    const issued = await issuePartnerApiKey(pool, "admission", "local", "operator:test");
    const reader = createPartnerKeyReader(() => pool);
    const client = await pool.connect();
    const original = client.query;
    let exchanges = 0;
    client.query = new Proxy(original, { apply(target, receiver, args) { exchanges += 1; return Reflect.apply(target, receiver, args); } });
    client.release();
    assert.equal((await reader.verify(issued.key))?.keyId, issued.id);
    assert.equal(exchanges, 1, "fresh verification must not await BEGIN and COMMIT separately");
    exchanges = 0;
    assert.equal(await reader.allowsOrigin("https://partner.example"), true);
    assert.equal(exchanges, 1, "origin preflight must retain its transaction without extra exchanges");
    for (const origin of ["https://x.example/'; COMMIT; DROP TABLE partner_api_keys; --", "https://例.example/\\", "\u0000"]) {
      try { assert.equal(await reader.allowsOrigin(origin), false); }
      catch (error) { assert.equal((error as { code: string }).code, "22021"); }
    }
    assert.equal((await reader.verify(issued.key))?.keyId, issued.id);
  } finally { await pool.end(); }
});
