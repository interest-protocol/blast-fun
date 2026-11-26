
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { createPublicReadCache } from "@blast/core/lib/public-read-cache.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { configuredRedis } from "@blast/core/lib/redis.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import type { PublicReadScope } from "@blast/server/modules/public-reads/namespace.ts";

/**
 * How long a miss waits for another process's load before running its own.
 * Social pages (the For You first page, Discover) take up to about 2 s on the
 * replica, so their wait covers that; others keep the one-second default.
 */
export const PUBLIC_READ_WAIT_MS: Readonly<Partial<Record<PublicReadScope, number>>> = { social: 3_000 };

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
      return createPublicReadCache(redis, config.publicReadNamespaces[scope], config.subjectPepper, { waitMs: PUBLIC_READ_WAIT_MS[scope] });
    } catch {
      recordMetric("public_read.cache", { outcome: "configuration_unavailable" });
      return createPublicPresaleReader();
    }
  });
}
