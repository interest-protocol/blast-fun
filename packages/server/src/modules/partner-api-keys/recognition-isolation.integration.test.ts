import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { recognitionFixture } from "../../../test/fixtures/partner-recognition.ts";
import { generatePartnerApiKey, hashPartnerApiKey } from "./contracts.ts";
import { PartnerCapacityError } from "./capacity.ts";
import { configuredPartnerRecognition } from "./recognition.ts";
import {
  createPartner,
  createPartnerKeyReader,
  deleteInactivePartnerGroup,
  deleteRevokedPartnerKey,
  issuePartnerApiKey,
  revokePartnerApiKey,
} from "./repository.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test(
  "an unreserved partner cannot block another partner's real key lifecycle or Redis recovery",
  {
    skip:
      databaseUrl && process.env.BLAST_TEST_REDIS_URL
        ? false
        : "Disposable PostgreSQL and Redis are required",
  },
  async (context) => {
    assert.ok(databaseUrl);
    assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
    context.after(recognitionFixture(["healthy"]));
    const admin = createPool(databaseUrl, { max: 1 });
    const runtime = createPool(urlAs(databaseUrl, "blast_web"), {
      max: 1,
    });
    try {
      await migrateDatabase(admin);
      const legacy = generatePartnerApiKey();
      const legacyId = randomUUID();
      await admin.query(
        "INSERT INTO partner_api_partners(id, origins, created_by, updated_by) VALUES ('unreserved', ARRAY['https://unreserved.example'], 'operator:test', 'operator:test')",
      );
      await admin.query(
        "INSERT INTO partner_api_keys(id, partner_id, label, key_hash, issued_by) VALUES ($1, 'unreserved', 'Legacy', $2, 'operator:test')",
        [legacyId, hashPartnerApiKey(legacy)],
      );
      await createPartner(
        runtime,
        { id: "healthy", origins: ["https://healthy.example"] },
        "operator:test",
      );
      const key = await issuePartnerApiKey(
        runtime,
        "healthy",
        "Disposable",
        "operator:test",
      );
      const recognition = configuredPartnerRecognition(runtime);
      const reader = createPartnerKeyReader(() => runtime);
      const classify = (raw: string) =>
        recognition.classify({
          digest: recognition.store.digest(hashPartnerApiKey(raw)),
          ip: "198.18.0.1",
        });
      assert.equal((await classify(key.key)).kind, "known");
      assert.equal((await reader.verify(key.key))?.keyId, key.id);
      assert.equal((await classify(legacy)).kind, "unknown");
      recognition.invalidate();
      await recognition.reconcile();
      assert.equal(recognition.ready(), true);
      assert.equal((await classify(key.key)).kind, "known");
      assert.equal((await classify(legacy)).kind, "unknown");
      assert.equal(
        (
          await recognition.classify({
            origin: "https://unreserved.example",
            ip: "198.18.0.1",
          })
        ).kind,
        "unknown",
      );
      await assert.rejects(
        issuePartnerApiKey(runtime, "unreserved", "Refused", "operator:test"),
        PartnerCapacityError,
      );
      assert.equal(recognition.ready(), true);
      assert.equal((await classify(key.key)).kind, "known");
      const stored = await admin.query(
        "SELECT requests_per_minute, requests_per_day FROM partner_api_keys WHERE id = $1",
        [legacyId],
      );
      assert.deepEqual(stored.rows, [
        { requests_per_minute: 300, requests_per_day: 50000 },
      ]);
      await revokePartnerApiKey(runtime, key.id, "operator:test");
      assert.equal(await reader.verify(key.key), null);
      assert.equal(
        await deleteRevokedPartnerKey(runtime, key.id, "operator:test"),
        true,
      );
      assert.equal(
        await deleteInactivePartnerGroup(runtime, "healthy", "operator:test"),
        true,
      );
      await revokePartnerApiKey(runtime, legacyId, "operator:test");
      assert.equal(
        await deleteRevokedPartnerKey(runtime, legacyId, "operator:test"),
        true,
      );
      assert.equal(
        await deleteInactivePartnerGroup(
          runtime,
          "unreserved",
          "operator:test",
        ),
        true,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM partner_api_keys",
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await runtime.end();
      await admin.end();
    }
  },
);
