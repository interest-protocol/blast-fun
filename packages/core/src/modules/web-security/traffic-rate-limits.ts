import { deploymentIdentity } from "../../lib/config/deployment-identity.ts";
import { requiredSecret } from "../../lib/config/secret.ts";
import { configuredRedis } from "../../lib/redis.ts";
import { PostgresRateLimitEnforcer } from "../database/postgres-rate-limits.ts";
import type { RateLimitPort } from "../../lib/web-security/rate-limits.ts";
import { FIRST_PARTY_READ_BUCKETS, quotaNamespace, RedisRateLimitEnforcer } from "../../lib/web-security/redis-rate-limits.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** Read traffic uses configured Redis; all other budgets keep PostgreSQL durability. */
export function trafficRateLimiter(environment: Environment = process.env): RateLimitPort {
  let postgres: RateLimitPort | undefined;
  let redisLimiter: RateLimitPort | undefined;
  return {
    async consume(bucket, subject) {
      if (FIRST_PARTY_READ_BUCKETS.has(bucket)) {
        // Configuration or transport failures propagate: never grant a fresh fallback allowance.
        const redis = configuredRedis("quota");
        if (redis) {
          redisLimiter ??= new RedisRateLimitEnforcer({
            redis, namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)), subjectPepper: requiredSecret(environment, "RATE_LIMIT_SUBJECT_PEPPER"),
          });
          return redisLimiter.consume(bucket, subject);
        }
      }
      if (!postgres) {
        const { primaryPool } = await import("../database/pool.ts");
        postgres ??= new PostgresRateLimitEnforcer({
          pool: primaryPool(), subjectPepper: requiredSecret(environment, "RATE_LIMIT_SUBJECT_PEPPER"),
        });
      }
      return postgres.consume(bucket, subject);
    },
  };
}
