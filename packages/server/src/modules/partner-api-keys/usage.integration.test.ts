import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { recognitionFixture } from "../../../test/fixtures/partner-recognition.ts";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { configuredRedis, createRedisConnection } from "@blast/core/lib/redis.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { DEFAULT_RATE_POLICIES, rateLimitSubjectKey } from "@blast/core/lib/web-security/rate-limits.ts";
import { RedisRateLimitEnforcer } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { createPartner, issuePartnerApiKey, listPartnerApiKeys } from "@blast/server/modules/partner-api-keys/repository.ts";
import { readPartnerKeyUsage } from "@blast/server/modules/partner-api-keys/usage.ts";
import { createAdminPartnerKeyRoute, partnerKeyAdminPorts } from "@blast/server/modules/partner-api-keys/admin-route.ts";
import { partnerRatePolicies } from "@blast/server/modules/partner-api-keys/runtime.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const redisUrl = process.env.BLAST_TEST_REDIS_URL;
const pepper = "usage-test-pepper-012345678901234567890123456789";

test("admin usage reads the actual PostgreSQL and Redis enforcement counters without spending or resetting quota", {
  skip: databaseUrl && redisUrl ? false : "Disposable PostgreSQL and Redis are required",
}, async (t) => {
  t.after(recognitionFixture(["usage-test"]));
  assert.ok(databaseUrl && redisUrl);
  const admin = createPool(databaseUrl, { max: 1 });
  const app = createPool(urlAs(databaseUrl, "blast_web"), { max: 1 });
  const redis = createRedisConnection(redisUrl, "quota");
  t.after(async () => { redis.close(); await app.end(); await admin.end(); });
  await migrateDatabase(admin);
  await createPartner(app, { id: "usage-test", origins: [] }, "operator:test");
  const key = await issuePartnerApiKey(app, "usage-test", "backend", "operator:test");
  // Keep the assertions within one minute, using the store's actual clock.
  const clock = await redis.execute(["TIME"]) as string[];
  const remaining = 60 - Number(clock[0]) % 60;
  if (remaining < 8) await setTimeout(remaining * 1_000 + 50);
  const namespace = `usage:${randomUUID()}`;
  const policies = { ...DEFAULT_RATE_POLICIES, partner_read: { ...DEFAULT_RATE_POLICIES.partner_read,
    windows: [{ limit: 2, windowSeconds: 60 }, { limit: 3, windowSeconds: 86_400 }] } };
  for (const store of [null, redis]) {
    const options = { pepper, namespace, redis: store };
    const limiter = store ? new RedisRateLimitEnforcer({ redis, namespace, subjectPepper: pepper, policies })
      : new PostgresRateLimitEnforcer({ pool: app, subjectPepper: pepper, policies });
    const read = () => readPartnerKeyUsage(app, [key], options);
    assert.equal((await read())[key.id].day, 0);
    for (let index = 0; index < 2; index++) assert.equal((await limiter.consume("partner_read", { apiKeyId: key.id })).allowed, true);
    assert.equal((await limiter.consume("partner_read", { apiKeyId: key.id })).allowed, false);
    const before = (await read())[key.id];
    assert.equal(before.minute, 2);
    assert.equal(before.day, 2);
    const after = (await read())[key.id];
    assert.equal(after.minute, before.minute, "Reading usage never consumes allowance");
    assert.equal(after.day, before.day);
    const updated = { ...key, tier: "custom" as const, requests_per_minute: 1, requests_per_day: 3 };
    assert.equal((await readPartnerKeyUsage(app, [updated], options))[key.id].day, 2, "Caps are not part of counter identity");
    assert.deepEqual(await readPartnerKeyUsage(app, [{ ...key, tier: "internal" }, { ...key, revoked_at: new Date() }], options), {});
    assert.equal(new Date(before.dayResetsAt).getUTCHours(), 0);
    assert.ok(Date.parse(before.minuteResetsAt) > Date.parse(before.observedAt));
    const batch = [key, ...Array.from({ length: 101 }, () => ({ ...key, id: randomUUID() }))];
    const batched = await readPartnerKeyUsage(app, batch, options);
    assert.equal(Object.keys(batched).length, 102, "Usage reads cover multiple bounded batches");
    assert.equal(batched[key.id].day, 2);
    assert.equal(batched[batch[101].id].day, 0);
  }
  const policy = DEFAULT_RATE_POLICIES.partner_read;
  const hash = createHmac("sha256", pepper).update(rateLimitSubjectKey(policy, { apiKeyId: key.id })).digest("hex");
  const minuteKey = `${namespace}:{partner-quota}:partner_read:v${policy.version}:${hash}:60`;
  await redis.execute(["SET", minuteKey, "0:99"]);
  const rolled = await readPartnerKeyUsage(app, [key], { pepper, namespace, redis });
  assert.equal(rolled[key.id].minute, 0, "A previous minute must not count in the current window");
  assert.equal(rolled[key.id].day, 2);
  assert.equal(await redis.execute(["GET", minuteKey]), "0:99", "Reading does not refresh or rewrite expired-window values");
  await redis.execute(["SET", minuteKey, "corrupt"]);
  await assert.rejects(readPartnerKeyUsage(app, [key], { pepper, namespace, redis }), /Redis command refused/);
  await assert.rejects(readPartnerKeyUsage(app, [key], { pepper, namespace, redis: { execute: async () => { throw new Error("Redis unavailable"); } } }), /Redis unavailable/,
    "Redis failures must not fall back to unrelated PostgreSQL counters");
  installRuntimeConfig({ RATE_LIMIT_SUBJECT_PEPPER: pepper, BLAST_QUOTA_REDIS_URL: undefined });
  const route = createAdminPartnerKeyRoute(partnerKeyAdminPorts(() => app));
  assert.ok((await listPartnerApiKeys(app)).keys.some((row) => row.id === key.id));
  const request = (body?: unknown) => new Request("https://blast.fun/api/admin/partner-keys", {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const listed = await route(request());
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).usage[key.id].day, 2);
  const withRedis = { RATE_LIMIT_SUBJECT_PEPPER: pepper, BLAST_QUOTA_REDIS_URL: redisUrl, BLAST_REDIS_NAMESPACE: namespace };
  installRuntimeConfig(withRedis);
  const productionRedis = configuredRedis("quota")!;
  t.after(() => productionRedis.close());
  // The backend admission's standard-key enforcer, in the runtime's configured namespace.
  const runtimeLimiter = new RedisRateLimitEnforcer({
    redis: productionRedis, subjectPepper: pepper, namespace: quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)), policies: partnerRatePolicies({ tier: "standard" }),
  });
  assert.equal((await runtimeLimiter.consume("partner_read", { apiKeyId: key.id })).allowed, true);
  const redisList = await route(request());
  assert.equal((await redisList.json()).usage[key.id].day, 1, "Admin wiring reads the runtime's Redis namespace, not PostgreSQL's count");
  // A missing namespace or pepper now stops boot (runtime-config.test.ts). The raw
  // namespace holds the corrupt minute counter written above: a refused Redis read.
  installRuntimeConfig(withRedis, { quotaNamespace: namespace });
  const unavailable = await route(request());
  assert.equal(unavailable.status, 200);
  assert.equal((await unavailable.json()).usage, null, "Telemetry failure does not prevent listing keys");
  const revoked = await route(request({ action: "revoke", id: key.id }));
  assert.equal(revoked.status, 200);
  assert.ok((await revoked.json()).apiKey.revoked_at, "Revocation remains available during a telemetry outage");
});
