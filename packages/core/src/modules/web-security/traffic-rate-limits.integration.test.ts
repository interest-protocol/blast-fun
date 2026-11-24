import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRedisConnection } from "../../lib/redis.ts";
import { DEFAULT_RATE_POLICIES } from "../../lib/web-security/rate-limits.ts";
import { RedisRateLimitEnforcer } from "../../lib/web-security/redis-rate-limits.ts";

test("first-party read windows are shared atomically across Redis connections and exclude money budgets", {
  skip: process.env.BLAST_TEST_REDIS_URL ? false : "BLAST_TEST_REDIS_URL is not set",
}, async (t) => {
  const url = process.env.BLAST_TEST_REDIS_URL!;
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname));
  const connections = [createRedisConnection(url, "quota"), createRedisConnection(url, "quota")];
  t.after(() => connections.forEach((connection) => connection.close()));
  const namespace = `test:${randomUUID()}`;
  const policies = { ...DEFAULT_RATE_POLICIES, social_read: {
    ...DEFAULT_RATE_POLICIES.social_read, windows: [{ limit: 3, windowSeconds: 60 }],
  } };
  const instances = connections.map((redis) => new RedisRateLimitEnforcer({
    redis, namespace, policies, subjectPepper: "synthetic-shared-read-pepper-01234567890123",
  }));
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    instances[index % 2]!.consume("social_read", { ip: "synthetic-shared-ip" })));
  assert.equal(results.filter((result) => result.allowed).length, 3);
  assert.ok(results.filter((result) => !result.allowed).every((result) => result.retryAfterSeconds > 0));
  assert.equal((await instances[0]!.consume("social_read", { ip: "different-ip" })).allowed, true);
  await assert.rejects(instances[0]!.consume("presale_sponsor_exec_global", {}), /restricted/);
});
