import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { recognitionFixture } from "../../../test/fixtures/partner-recognition.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { setTimeout } from "node:timers/promises";
import { createRedisConnection, type RedisCommands } from "@blast/core/lib/redis.ts";
import { DEFAULT_RATE_POLICIES, type RateBucket, type RatePolicy } from "@blast/core/lib/web-security/rate-limits.ts";
import { RedisRateLimitEnforcer } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { urlAs, ROLES } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { createAdminPartnerKeyRoute, partnerKeyAdminPorts } from "@blast/server/modules/partner-api-keys/admin-route.ts";
import { partnerRatePolicies } from "@blast/server/modules/partner-api-keys/runtime.ts";
import { hashPartnerApiKey, type PartnerKeyPolicy, type PartnerKeyReader } from "@blast/server/modules/partner-api-keys/contracts.ts";
import { createPartner, createPartnerKeyReader, issuePartnerApiKey, listPartnerApiKeys, revokePartnerApiKey, setPartnerOrigins, setPartnerKeyPolicy } from "@blast/server/modules/partner-api-keys/repository.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const ORIGIN = "https://partner.example";

type Instance = Readonly<{ keys: PartnerKeyReader; redis: RedisCommands }>;
type Policies = (policy: PartnerKeyPolicy) => Readonly<Record<RateBucket, RatePolicy>>;

/**
 * The key repository and the Redis quota enforcer composed in the backend's order (fresh primary
 * grant, origin, then the key's `partner_read` quota). It is not the admission itself: the real
 * decision also charges the global and endpoint buckets, and is covered end to end by
 * apps/backend-api/test/partner-runtime.integration.test.ts.
 */
async function admitPartner(instance: Instance, key: string, policies: Policies, origin?: string) {
  const grant = await instance.keys.verify(key);
  if (!grant) return { status: 401, retryAfter: 0 };
  const internal = grant.policy.tier === "internal";
  if (origin && (internal || !grant.origins.includes(origin))) return { status: 403, retryAfter: 0 };
  if (internal) return { status: 200, retryAfter: 0 };
  const quota = new RedisRateLimitEnforcer({
    redis: instance.redis, namespace: quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)), subjectPepper: process.env.RATE_LIMIT_SUBJECT_PEPPER!,
    policies: policies(grant.policy),
  });
  const decision = await quota.consumeAll(["partner_read"], { apiKeyId: grant.keyId });
  return { status: decision.allowed ? 200 : 429, retryAfter: decision.retryAfterSeconds };
}

/** Redis owns the clock: keep a minute's assertions inside one minute and one UTC day. */
async function quotaHeadroom(redis: RedisCommands) {
  const [seconds] = await redis.execute(["TIME"]) as string[];
  const minute = 60 - Number(seconds) % 60;
  const day = 86_400 - Number(seconds) % 86_400;
  if (day < 120) await setTimeout(day * 1_000 + 50);
  else if (minute < 10) await setTimeout(minute * 1_000 + 50);
}

test("partner key migration and runtime enforce immediate revocation on independent database connections", {
  skip: databaseUrl && process.env.BLAST_TEST_REDIS_URL ? false : "Disposable PostgreSQL and Redis are required",
}, async (context) => {
  context.after(recognitionFixture(["acme", "console-partner", "internal-only"]));
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 1 });
  const webA = createPool(urlAs(databaseUrl, "blast_web"), { max: 1 });
  const webB = createPool(urlAs(databaseUrl, "blast_web"), { max: 1 });
  const redisA = createRedisConnection(process.env.BLAST_TEST_REDIS_URL!, "quota");
  const redisB = createRedisConnection(process.env.BLAST_TEST_REDIS_URL!, "quota");
  try {
    const migrated = await migrateDatabase(admin);
    assert.ok(migrated.includes("0124_partner_api_keys"));
    assert.deepEqual(await migrateDatabase(admin), [], "migration is idempotent");
    const partner = { id: "acme", origins: [ORIGIN] };
    await createPartner(webA, partner, "operator:ops-a");
    const original = await issuePartnerApiKey(webA, partner.id, "backend", "operator:ops-a");
    const rotated = await issuePartnerApiKey(webA, partner.id, "rotation", "operator:ops-a");
    const readerA = createPartnerKeyReader(() => webA);
    const readerB = createPartnerKeyReader(() => webB);

    await context.test("only hashes persist and listing never returns secrets or hashes", async () => {
      const stored = await admin.query("SELECT key_hash FROM partner_api_keys WHERE id = $1", [original.id]);
      assert.deepEqual(stored.rows[0].key_hash, hashPartnerApiKey(original.key));
      const list = JSON.stringify(await listPartnerApiKeys(webB));
      assert.equal(list.includes(original.key), false);
      assert.equal(list.includes(rotated.key), false);
      assert.equal(list.includes("key_hash"), false);
      assert.equal(list.includes("operator:ops-a"), true);
    });

    await context.test("revocation rejects the next authorization on both instances and a replacement key has its own quota", async () => {
      const policy = { ...DEFAULT_RATE_POLICIES, partner_read: {
        ...DEFAULT_RATE_POLICIES.partner_read, windows: [{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 86_400 }],
      } };
      const instanceA = { keys: readerA, redis: redisA };
      const instanceB = { keys: readerB, redis: redisB };
      const call = async (key: string, instance: Instance = instanceA) => (await admitPartner(instance, key, () => policy, ORIGIN)).status;
      await quotaHeadroom(redisA);
      assert.equal(await call(original.key), 200);
      assert.equal(await call(original.key, instanceB), 200);
      assert.equal(await readerB.allowsOrigin(ORIGIN), true);
      const revoked = await revokePartnerApiKey(webA, original.id, "operator:ops-b");
      assert.ok(revoked?.revoked_at);
      assert.equal(revoked.revoked_by, "operator:ops-b");
      assert.equal(await call(original.key), 401);
      assert.equal(await call(original.key, instanceB), 401);
      assert.equal(await call(rotated.key, instanceB), 200);
      assert.equal(await call(rotated.key), 200);
      assert.equal(await call(rotated.key), 200);
      assert.equal(await call(rotated.key), 429);
      assert.deepEqual(await revokePartnerApiKey(webA, original.id, "operator:ops-c"), revoked, "repeat revocation preserves its original audit");
    });

    await context.test("origin changes are immediate; removing the last active key also disables preflight", async () => {
      await setPartnerOrigins(webA, { ...partner, origins: ["https://new.example"] }, "operator:ops-b");
      assert.equal(await readerA.allowsOrigin(ORIGIN), false);
      assert.equal(await readerB.allowsOrigin(ORIGIN), false);
      assert.equal(await readerB.allowsOrigin("https://new.example"), true);
      assert.deepEqual((await readerB.verify(rotated.key))?.origins, ["https://new.example"]);
      assert.equal((await admitPartner({ keys: readerB, redis: redisB }, rotated.key, partnerRatePolicies, ORIGIN)).status, 403);
      await revokePartnerApiKey(webA, rotated.id, "operator:ops-b");
      assert.equal(await readerB.verify(rotated.key), null);
      assert.equal(await readerB.allowsOrigin("https://new.example"), false);
      assert.equal(await revokePartnerApiKey(webA, "00000000-0000-4000-8000-000000000001", "operator:ops-b"), null);
    });

    await context.test("database grants prevent key edits and deletion; revoked keys cannot be re-enabled", async () => {
      await assert.rejects(webA.query("UPDATE partner_api_keys SET revoked_at = NULL, revoked_by = NULL WHERE id = $1", [original.id]), { code: "23514", constraint: "partner_api_keys_revocation_final" });
      for (const sql of [
        "UPDATE partner_api_keys SET key_hash = key_hash WHERE FALSE",
        "UPDATE partner_api_keys SET partner_id = partner_id WHERE FALSE",
        "UPDATE partner_api_keys SET issued_by = issued_by WHERE FALSE",
        "DELETE FROM partner_api_keys WHERE FALSE", "DELETE FROM partner_api_partners WHERE FALSE",
      ]) await assert.rejects(webA.query(sql), { code: "42501" });
      const grants = await admin.query(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name IN ('partner_api_keys','partner_api_partners') AND grantee = ANY($1)
        ORDER BY table_name, privilege_type`, [ROLES]);
      assert.deepEqual(grants.rows, ["partner_api_keys", "partner_api_partners"].flatMap((table_name) => ["INSERT", "SELECT"].map((privilege_type) => ({ grantee: "blast_web", table_name, privilege_type }))));
    });

    await context.test("admin route audit identity satisfies the real schema and revocation reaches other instances", async () => {
      const route = createAdminPartnerKeyRoute(partnerKeyAdminPorts(() => webA));
      const call = async (body: unknown) => {
        const response = await route(new Request("https://blast.fun/api/admin/partner-keys", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }));
        assert.equal(response.status, 200);
        return response.json();
      };
      await call({ action: "create-partner", id: "console-partner", origins: [] });
      const { apiKey: issued } = await call({ action: "issue", partnerId: "console-partner", label: "Backend" });
      assert.equal(issued.issued_by, "operator:admin-console");
      assert.equal((await readerB.verify(issued.key))?.id, "console-partner");
      const { apiKey: revoked } = await call({ action: "revoke", id: issued.id });
      assert.equal(revoked.revoked_by, "operator:admin-console");
      assert.equal(await readerB.verify(issued.key), null);
    });

    await context.test("per-key tiers share counters across instances and policy changes cannot reset usage", async () => {
      const issued = await issuePartnerApiKey(webA, "console-partner", "tier-test", "operator:ops-a");
      const minute = { tier: "custom", requestsPerMinute: 2, requestsPerDay: 3 } as const;
      await setPartnerKeyPolicy(webA, issued.id, minute, "operator:ops-b");
      const instanceA = { keys: readerA, redis: redisA };
      const instanceB = { keys: readerB, redis: redisB };
      const call = (instance: Instance) => admitPartner(instance, issued.key, partnerRatePolicies);
      await quotaHeadroom(redisA);
      assert.equal((await call(instanceA)).status, 200);
      assert.equal((await call(instanceB)).status, 200);
      assert.equal((await call(instanceA)).status, 429);
      await setPartnerKeyPolicy(webA, issued.id, { ...minute, requestsPerMinute: 3 }, "operator:ops-b");
      assert.equal((await call(instanceB)).status, 200);
      // The day window refuses (its retry outlasts any minute): the daily count survived the policy update.
      const daily = await call(instanceB);
      assert.equal(daily.status, 429);
      assert.ok(daily.retryAfter > 60, "Daily count survived the policy update");
      await setPartnerKeyPolicy(webA, issued.id, { tier: "internal" }, "operator:ops-b");
      for (let i = 0; i < 12; i++) assert.equal((await call(instanceB)).status, 200);
      await setPartnerKeyPolicy(webA, issued.id, minute, "operator:ops-b");
      const resumed = await call(instanceB);
      assert.equal(resumed.status, 429);
      assert.ok(resumed.retryAfter > 60, "Internal access did not clear the previous daily count");
      const events = await webB.query("SELECT tier, changed_by FROM partner_api_key_policy_events WHERE key_id = $1 ORDER BY id", [issued.id]);
      assert.deepEqual(events.rows.map((row) => row.tier), ["standard", "custom", "custom", "internal", "custom"]);
      assert.equal(events.rows[0].changed_by, "operator:ops-a");
      assert.equal(events.rows.at(-1).changed_by, "operator:ops-b");
      for (const sql of ["DELETE FROM partner_api_key_policy_events WHERE FALSE", "UPDATE partner_api_key_policy_events SET tier = tier WHERE FALSE"])
        await assert.rejects(webA.query(sql), { code: "42501" });
      for (const values of [["internal", 1, null], ["custom", 0, 5], ["custom", null, 5], ["custom", 10, 5], ["standard", 10, 100], ["unknown", null, null]])
        await assert.rejects(webA.query("UPDATE partner_api_keys SET tier = $2, requests_per_minute = $3, requests_per_day = $4 WHERE id = $1", [issued.id, ...values]), { code: "23514" });
      const before = await webA.query("SELECT policy_updated_at, policy_updated_by FROM partner_api_keys WHERE id = $1", [issued.id]);
      await setPartnerKeyPolicy(webA, issued.id, minute, "operator:ops-c");
      await webA.query("UPDATE partner_api_keys SET policy_updated_by = 'operator:forged-actor' WHERE id = $1", [issued.id]);
      const after = await webB.query("SELECT policy_updated_at, policy_updated_by FROM partner_api_keys WHERE id = $1", [issued.id]);
      assert.deepEqual(after.rows, before.rows, "No-op and actor-only updates cannot rewrite policy attribution");
      assert.equal((await webB.query("SELECT count(*)::int AS count FROM partner_api_key_policy_events WHERE key_id = $1", [issued.id])).rows[0].count, 5);
      await createPartner(webA, { id: "internal-only", origins: ["https://internal.example"] }, "operator:ops-a");
      const internal = await issuePartnerApiKey(webA, "internal-only", "internal", "operator:ops-a");
      assert.equal(await readerB.allowsOrigin("https://internal.example"), true);
      await setPartnerKeyPolicy(webA, internal.id, { tier: "internal" }, "operator:ops-a");
      assert.equal(await readerB.allowsOrigin("https://internal.example"), false);
      await revokePartnerApiKey(webA, issued.id, "operator:ops-a");
      assert.equal(await readerB.verify(issued.key), null);
      assert.equal(await setPartnerKeyPolicy(webA, issued.id, { tier: "internal" }, "operator:ops-b"), null);
    });

    await context.test("migration rolls back and reapplies cleanly on the disposable database", async () => {
      const base = new URL("../../../../core/src/modules/database/migrations/", import.meta.url);
      await admin.query(await readFile(new URL("0127_partner_key_tiers.down.sql", base), "utf8"));
      await admin.query(await readFile(new URL("0124_partner_api_keys.down.sql", base), "utf8"));
      await admin.query(await readFile(new URL("0124_partner_api_keys.up.sql", base), "utf8"));
      await admin.query(await readFile(new URL("0127_partner_key_tiers.up.sql", base), "utf8"));
      assert.deepEqual(await listPartnerApiKeys(webB), { partners: [], keys: [] });
    });
  } finally {
    redisA.close();
    redisB.close();
    await webA.end();
    await webB.end();
    await admin.end();
  }
});
