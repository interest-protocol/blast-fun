import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";
import { configuredRedis, redisScript, type RedisCommands } from "@blast/core/lib/redis.ts";
import { DEFAULT_RATE_POLICIES, rateLimitSubjectKey } from "@blast/core/lib/web-security/rate-limits.ts";
import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { PartnerKeySummary } from "@blast/server/modules/partner-api-keys/repository.ts";

export type PartnerKeyUsage = {
  minute: number; day: number; observedAt: string;
  minuteResetsAt: string; dayResetsAt: string;
};

const quotaCounterSchema = z.number().int().nonnegative();
const quotaCountersSchema = z.tuple([quotaCounterSchema, quotaCounterSchema, quotaCounterSchema]);
const USAGE_BATCH_SIZE = 100;

// Read the enforcement counters with the store's clock. Never increment or refresh a TTL.
const readCounters = redisScript(`
local now = tonumber(redis.call('TIME')[1])
local result = {now}
for i, key in ipairs(KEYS) do
  local seconds = tonumber(ARGV[i])
  local count = 0
  local previous = redis.call('GET', key)
  if previous then
    local stamp, total = string.match(previous, '^(%d+):(%d+)$')
    if not stamp then return redis.error_reply('CORRUPT quota counter') end
    if tonumber(stamp) == now - now % seconds then count = tonumber(total) end
  end
  result[#result + 1] = count
end
return result
`);

function snapshot(values: readonly unknown[]): PartnerKeyUsage {
  const parsed = quotaCountersSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error("Invalid quota counters");
  }
  const [now, minute, day] = parsed.data;
  const date = (seconds: number) => new Date(seconds * 1_000).toISOString();
  return { minute, day, observedAt: date(now), minuteResetsAt: date(now - now % 60 + 60), dayResetsAt: date(now - now % 86_400 + 86_400) };
}

/** Only active metered keys have usage: internal requests are deliberately uncounted. */
export async function readPartnerKeyUsage(pool: Pool, keys: readonly PartnerKeySummary[], options: {
  pepper: string; redis: RedisCommands | null; namespace: string;
}): Promise<Record<string, PartnerKeyUsage>> {
  const active = keys.filter((key) => !key.revoked_at && key.tier !== "internal");
  if (!active.length) return {};
  if (options.pepper.length < MINIMUM_SECRET_LENGTH) throw new Error("Quota reader is not configured");
  const policy = DEFAULT_RATE_POLICIES.partner_read;
  const usage: Record<string, PartnerKeyUsage> = {};
  async function readBatch(batch: readonly PartnerKeySummary[]): Promise<void> {
    const hashes = batch.map((key) => createHmac("sha256", options.pepper)
      .update(rateLimitSubjectKey(policy, { apiKeyId: key.id })).digest("hex"));
    if (options.redis) {
      const counterKeys = hashes.flatMap((hash) => [60, 86_400].map((seconds) =>
        `${options.namespace}:{partner-quota}:partner_read:v${policy.version}:${hash}:${seconds}`));
      const result = await readCounters(options.redis, counterKeys, hashes.flatMap(() => ["60", "86400"]));
      const parsed = z.array(z.unknown()).length(1 + batch.length * 2).safeParse(result);
      if (!parsed.success) throw new Error("Invalid quota snapshot");
      batch.forEach((key, index) => { usage[key.id] = snapshot([parsed.data[0], parsed.data[index * 2 + 1], parsed.data[index * 2 + 2]]); });
    } else {
      const result = await autocommitRead<{ subject_hash: string; now: number; minute: number; day: number }>(pool, "web-security", `
        SELECT subjects.subject_hash, clock.now::float8 AS now,
          coalesce(max(w.request_count) FILTER (WHERE w.window_seconds = 60), 0)::float8 AS minute,
          coalesce(max(w.request_count) FILTER (WHERE w.window_seconds = 86400), 0)::float8 AS day
        FROM unnest($1::text[]) AS subjects(subject_hash)
        CROSS JOIN (SELECT floor(extract(epoch FROM statement_timestamp()))::bigint AS now) clock
        LEFT JOIN mission_control_rate_limit_windows w ON w.subject_hash = subjects.subject_hash
          AND w.policy_name = 'partner_read' AND w.policy_version = $2
          AND w.window_seconds IN (60, 86400)
          AND w.window_started_at = to_timestamp(clock.now - clock.now % w.window_seconds)
        GROUP BY subjects.subject_hash, clock.now`, [hashes, policy.version], { label: "partner.usage" });
      const rows = new Map(result.rows.map((row) => [row.subject_hash, row]));
      batch.forEach((key, index) => {
        const row = rows.get(hashes[index]);
        if (!row) throw new Error("Missing quota snapshot");
        usage[key.id] = snapshot([row.now, row.minute, row.day]);
      });
    }
  }
  // Two workers overlap independent reads without flooding either store. On
  // failure, stop taking batches and drain the other read before rejecting.
  const pending: { offset: number; failure?: { error: unknown } } = { offset: 0 };
  async function readNextBatch(): Promise<void> {
    if (pending.failure || pending.offset >= active.length) return;
    const batch = active.slice(pending.offset, pending.offset + USAGE_BATCH_SIZE);
    pending.offset += USAGE_BATCH_SIZE;
    try {
      await readBatch(batch);
    } catch (error) {
      pending.failure ??= { error };
      return;
    }
    return readNextBatch();
  }
  await Promise.all([readNextBatch(), readNextBatch()]);
  if (pending.failure) throw pending.failure.error;
  // Completion order must not change the caller's key order.
  return Object.fromEntries(active.map((key) => [key.id, usage[key.id]]));
}

export async function partnerKeyUsage(pool: Pool, keys: readonly PartnerKeySummary[]) {
  const redis = configuredRedis("quota");
  return readPartnerKeyUsage(pool, keys, {
    pepper: runtimeConfig().subjectPepper,
    redis, namespace: redis ? runtimeConfig().quotaNamespace : "",
  });
}
