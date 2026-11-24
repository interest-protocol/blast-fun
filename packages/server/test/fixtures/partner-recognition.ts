import { randomUUID } from "node:crypto";
import { configuredRedis } from "@blast/core/lib/redis.ts";

/** Disposable scheduling envelope, never a production capacity recommendation. */
export function recognitionFixture(ids: readonly string[]) {
  const redis = process.env.BLAST_TEST_REDIS_URL;
  if (!redis || new URL(redis).hostname !== "127.0.0.1")
    throw new Error("Disposable loopback Redis is required.");
  const environment = {
    BLAST_PARTNER_CAPACITY_CONFIG: JSON.stringify({
      maxReplicas: 2,
      internalMaxInflight: 8,
      maxEntries: 20000,
      maxBytes: 4194304,
      maxOrigins: 1000,
      safeRequestsPerMinute: ids.length * 4_000_000 + 40_000,
      evidence: "disposable-local-fixture-not-production-capacity",
      reserves: {
        preflight: 1000,
        anonymous: 10000,
        unknown: 3000,
        admin: 1000,
        internal: 10000,
      },
      classifierInflight: 32,
      queueWaitMs: 500,
      tenants: ids.map((id) => ({
        id,
        requestsPerMinute: 4_000_000,
        keyRequestsPerMinute: 100000,
        maxInflight: 32,
        queueLimit: 16,
      })),
    }),
    BLAST_QUOTA_REDIS_URL: redis,
    BLAST_REDIS_NAMESPACE: "recognition-test:" + randomUUID(),
    RATE_LIMIT_SUBJECT_PEPPER:
      "synthetic-recognition-pepper-01234567890123456789",
    BLAST_DEPLOYMENT_TARGET: "preview",
    BLAST_DEPLOYMENT_BRANCH: "recognition-fixture",
  };
  const prior = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  return () => {
    configuredRedis("quota")?.close();
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
