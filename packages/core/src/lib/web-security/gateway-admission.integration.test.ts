import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createRedisConnection } from "../redis.ts";
import { DEFAULT_RATE_POLICIES, type RateBucket } from "./rate-limits.ts";
import { GatewayReplayError, RedisRateLimitEnforcer } from "./redis-rate-limits.ts";

const url = process.env.BLAST_TEST_REDIS_URL;
const nonce = () => randomBytes(24).toString("base64url");
const pepper = "synthetic-gateway-rate-pepper-01234567890123456789";

test("gateway nonce and first admission are atomic across connections, including refusal and script eviction", { skip: !url }, async (t) => {
  assert.ok(url);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const connections = [createRedisConnection(url, "quota"), createRedisConnection(url, "quota")];
  t.after(() => connections.forEach((connection) => connection.close()));
  const namespace = `gateway-test:${randomUUID()}`;
  const instances = connections.map((redis) => new RedisRateLimitEnforcer({ redis, namespace, subjectPepper: pepper }));
  const shared = nonce();
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => instances[index % 2]!.consumeAll(["social_read_prices"], { ip: "198.51.100.7" }, shared)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof GatewayReplayError).length, 39);
  const redis = connections[0]!;
  const usage = await redis.execute(["KEYS", `${namespace}:*:social_read_prices:*`]) as string[];
  assert.equal(usage.length, 1);
  assert.match(String(await redis.execute(["GET", usage[0]!])), /:1$/);
  const replayKey = `${namespace}:{partner-quota}:gateway-replay:${shared}`;
  const ttl = await redis.execute(["TTL", replayKey]) as number;
  assert.ok(ttl > 0 && ttl <= 30);

  const buckets: RateBucket[] = ["partner_read", "partner_read_global", "launchpad_market_status"];
  for (const [index, exhausted] of buckets.entries()) {
    const selectedNamespace = `${namespace}:refusal${index}`;
    const policies = { ...DEFAULT_RATE_POLICIES };
    for (const bucket of buckets) policies[bucket] = { ...policies[bucket], windows: [{ windowSeconds: 60, limit: 1 }] };
    const limiter = new RedisRateLimitEnforcer({ redis, namespace: selectedNamespace, subjectPepper: pepper, policies });
    const subject = { apiKeyId: "synthetic-key", ip: "198.51.100.8" };
    assert.equal((await limiter.consume(exhausted, subject)).allowed, true);
    const beforeKeys = await redis.execute(["KEYS", `${selectedNamespace}:*`]) as string[];
    const before = await Promise.all(beforeKeys.map((key) => redis.execute(["GET", key])));
    const refusedNonce = nonce();
    const refused = await limiter.consumeAll(buckets, subject, refusedNonce);
    assert.equal(refused.allowed, false);
    assert.equal(refused.bucket, exhausted);
    assert.deepEqual(await Promise.all(beforeKeys.map((key) => redis.execute(["GET", key]))), before);
    const afterKeys = await redis.execute(["KEYS", `${selectedNamespace}:*`]) as string[];
    assert.equal(afterKeys.length, beforeKeys.length + 1, "Refusal writes only the transport nonce.");
    await assert.rejects(limiter.consumeAll(buckets, subject, refusedNonce), GatewayReplayError);
    assert.deepEqual(await Promise.all(beforeKeys.map((key) => redis.execute(["GET", key]))), before);
  }
  await redis.execute(["SCRIPT", "FLUSH"]);
  const cold = nonce();
  assert.equal((await instances[0]!.consumeAll(["social_read_prices"], { ip: "198.51.100.9" }, cold)).allowed, true);
  await assert.rejects(instances[1]!.consumeAll(["social_read_prices"], { ip: "198.51.100.9" }, cold), GatewayReplayError);
  const withoutQuota = nonce();
  await instances[0]!.claimGatewayNonce(withoutQuota);
  await assert.rejects(instances[1]!.claimGatewayNonce(withoutQuota), GatewayReplayError);
});

test("Lua validates all counters and arguments before any nonce or quota write", { skip: !url }, async (t) => {
  assert.ok(url);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const redis = createRedisConnection(url, "quota");
  t.after(() => redis.close());
  const namespace = `gateway-invalid:${randomUUID()}`;
  let captured: string[] = [];
  const limiter = new RedisRateLimitEnforcer({ namespace, subjectPepper: pepper,
    redis: { execute(command) { captured = command; return redis.execute(command); } },
  });
  const subject = { apiKeyId: "synthetic-key", ip: "198.51.100.10" };
  await limiter.consumeAll(["partner_read", "partner_read_global"], subject, nonce());
  assert.ok(["EVAL", "EVALSHA"].includes(captured[0]!));
  const keyCount = Number(captured[2]);
  const keys = captured.slice(3, 3 + keyCount);
  const quotaKeys = keys.slice(1);
  const before = await Promise.all(quotaKeys.map((key) => redis.execute(["GET", key])));
  const freshNonce = nonce();
  const freshKey = `${namespace}:{partner-quota}:gateway-replay:${freshNonce}`;
  const malformed = [...captured]; malformed[3] = freshKey;
  malformed[3 + keyCount + 2] = "0"; // First window's cap.
  await assert.rejects(redis.execute(malformed));
  assert.equal(await redis.execute(["GET", freshKey]), null);
  assert.deepEqual(await Promise.all(quotaKeys.map((key) => redis.execute(["GET", key]))), before);
  const damaged = quotaKeys.at(-1)!;
  await redis.execute(["DEL", damaged]);
  await redis.execute(["LPUSH", damaged, "wrong-type"]);
  await assert.rejects(limiter.consumeAll(["partner_read", "partner_read_global"], subject, freshNonce));
  assert.equal(await redis.execute(["GET", freshKey]), null);
  assert.deepEqual(await Promise.all(quotaKeys.slice(0, -1).map((key) => redis.execute(["GET", key]))), before.slice(0, -1));
});
