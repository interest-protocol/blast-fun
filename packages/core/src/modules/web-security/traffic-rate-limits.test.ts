import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { testClient } from "../../../test/fixtures/lib/web-security/client-address.ts";
import { endProcessPools } from "../../../test/fixtures/modules/database/testing.ts";
import { PostgresRateLimitEnforcer } from "../database/postgres-rate-limits.ts";
import type { RateBucket, RateLimitSubject } from "../../lib/web-security/rate-limits.ts";
import { quotaNamespace, RedisRateLimitEnforcer } from "../../lib/web-security/redis-rate-limits.ts";
import { withRouteLimits } from "./route-limits.ts";
import { trafficRateLimiter } from "./traffic-rate-limits.ts";

const pepper = "synthetic-traffic-pepper-01234567890123456789";
const environment = { RATE_LIMIT_SUBJECT_PEPPER: pepper, BLAST_REDIS_NAMESPACE: "synthetic-traffic" };

function setEnvironment(t: TestContext, key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("shared quota namespace preserves existing production counters and separates preview branches", () => {
  const production = { BLAST_REDIS_NAMESPACE: "sui-mainnet:deployment-123", BLAST_DEPLOYMENT_TARGET: "production" };
  assert.equal(quotaNamespace(production.BLAST_REDIS_NAMESPACE, deploymentIdentity(production)), "e36814773c0907586d08a1ec8a5f6e7b4de5492b2ac7e25c7fed1f4e379a3786");
  assert.equal(quotaNamespace(production.BLAST_REDIS_NAMESPACE, deploymentIdentity({ ...production, BLAST_DEPLOYMENT_BRANCH: "main" })), quotaNamespace(production.BLAST_REDIS_NAMESPACE, deploymentIdentity(production)));
  const preview = { ...production, BLAST_DEPLOYMENT_TARGET: "preview", BLAST_DEPLOYMENT_BRANCH: "branch-a" };
  assert.notEqual(quotaNamespace(preview.BLAST_REDIS_NAMESPACE, deploymentIdentity(preview)), quotaNamespace(production.BLAST_REDIS_NAMESPACE, deploymentIdentity(production)));
  assert.notEqual(quotaNamespace(preview.BLAST_REDIS_NAMESPACE, deploymentIdentity({ ...preview, BLAST_DEPLOYMENT_BRANCH: "branch-b" })), quotaNamespace(preview.BLAST_REDIS_NAMESPACE, deploymentIdentity(preview)));
});

test("configured public-read quotas count every cache hit without a primary database", async (t) => {
  setEnvironment(t, "BLAST_QUOTA_REDIS_URL", "redis://127.0.0.1:9");
  setEnvironment(t, "DATABASE_URL", "");
  let reads = 0;
  let served = 0;
  t.mock.method(RedisRateLimitEnforcer.prototype, "consume", async (bucket: RateBucket, subject: RateLimitSubject) => {
    assert.equal(bucket, "social_read_presales");
    assert.equal(subject.ip, "203.0.113.7");
    reads++;
    return { allowed: reads <= 2, bucket, policyVersion: 1, retryAfterSeconds: reads > 2 ? 60 : 0 };
  });
  t.mock.method(PostgresRateLimitEnforcer.prototype, "consume", () => assert.fail("No primary work for a Redis read quota"));
  const limiter = trafficRateLimiter(environment);
  for (const expected of [200, 200, 429]) {
    const response = await withRouteLimits(testClient(), ["social_read_presales"], async () => {
      served++;
      return Response.json({ source: "cached-public-data" });
    }, { limiter });
    assert.equal(response.status, expected);
  }
  assert.equal(reads, 3);
  assert.equal(served, 2, "An exhausted quota never runs the cached-data handler");
});

test("a configured Redis outage fails closed without charging a fresh PostgreSQL allowance", async (t) => {
  setEnvironment(t, "BLAST_QUOTA_REDIS_URL", "redis://127.0.0.1:9");
  setEnvironment(t, "DATABASE_URL", "");
  t.mock.method(RedisRateLimitEnforcer.prototype, "consume", async () => { throw new Error("Synthetic Redis failure"); });
  t.mock.method(PostgresRateLimitEnforcer.prototype, "consume", () => assert.fail("Never switch allowance stores during an outage"));
  const response = await withRouteLimits(testClient(), ["launchpad_search"],
    async () => assert.fail("An unavailable quota cannot grant a read"), { limiter: trafficRateLimiter(environment) });
  assert.equal(response.status, 503);
});

test("write, private-account and sponsorship budgets stay on PostgreSQL even with invalid Redis configuration", async (t) => {
  setEnvironment(t, "BLAST_QUOTA_REDIS_URL", "redis://unsafe-host.invalid:6379");
  setEnvironment(t, "DATABASE_URL", "postgresql://app:synthetic@127.0.0.1:9/never_connected");
  t.after(endProcessPools);
  const counted: string[] = [];
  t.mock.method(RedisRateLimitEnforcer.prototype, "consume", () => assert.fail("Private and money budgets never use Redis"));
  t.mock.method(PostgresRateLimitEnforcer.prototype, "consume", async (bucket: RateBucket) => {
    counted.push(bucket);
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  });
  const limiter = trafficRateLimiter(environment);
  const buckets = ["social_account_create", "social_me_read", "social_trade_quote", "presale_sponsor_exec_global"] as const;
  for (const bucket of buckets) {
    assert.equal((await limiter.consume(bucket, { ip: "synthetic", accountId: "did:privy:synthetic" })).allowed, true);
  }
  assert.deepEqual(counted, buckets);
});

test("an environment without Redis retains durable read admission", async (t) => {
  setEnvironment(t, "BLAST_QUOTA_REDIS_URL", "");
  setEnvironment(t, "DATABASE_URL", "postgresql://app:synthetic@127.0.0.1:9/never_connected");
  t.after(endProcessPools);
  let calls = 0;
  t.mock.method(PostgresRateLimitEnforcer.prototype, "consume", async (bucket: RateBucket) => {
    calls++;
    return { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 17 };
  });
  const decision = await trafficRateLimiter(environment).consume("launchpad_market_status", { ip: "synthetic" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryAfterSeconds, 17);
  assert.equal(calls, 1);
});
