
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { createPublicReadCache, type PublicReadCacheOptions } from "@blast/core/lib/public-read-cache.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { configuredRedis } from "@blast/core/lib/redis.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import type { PublicReadScope } from "@blast/server/modules/public-reads/namespace.ts";

/**
 * Social pages (the For You first page, Discover) take up to about 2 s on the
 * replica: a miss waits for another process's load rather than running its
 * own (one scan at a time, so a cold request in a replica brown-out can take
 * 4-5 s before failing), and the answer carries its read time, so it expires
 * ten seconds after that read. Other scopes keep the defaults.
 */
export const PUBLIC_READ_OPTIONS: Readonly<Partial<Record<PublicReadScope, PublicReadCacheOptions>>> = {
  social: { waitMs: 3_000, expireFromReadStart: true },
};

/**
 * Shared public data only. Personal reads and fresh lifecycle detail never
 * enter Redis. Without the cache's namespace (`RuntimeConfig.publicReadNamespaces`
 * null: no replica or no deployment identity) reads go uncached, with a metric.
 */
export function publicReadCache(scope: PublicReadScope) {
  return processSingleton(`public-read-cache.${scope}`, () => {
    try {
      const redis = configuredRedis("cache");
      if (!redis) return createPublicPresaleReader();
      const config = runtimeConfig();
      if (!config.publicReadNamespaces) throw new Error("Shared public caching is not configured.");
      return createPublicReadCache(redis, config.publicReadNamespaces[scope], config.subjectPepper, PUBLIC_READ_OPTIONS[scope]);
    } catch {
      recordMetric("public_read.cache", { outcome: "configuration_unavailable" });
      return createPublicPresaleReader();
    }
  });
}
