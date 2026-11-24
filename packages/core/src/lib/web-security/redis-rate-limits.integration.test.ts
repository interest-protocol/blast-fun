import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { createRedisConnection, verifyQuotaStorage } from "../redis.ts";
import { DEFAULT_RATE_POLICIES } from "./rate-limits.ts";
import { RedisRateLimitEnforcer } from "./redis-rate-limits.ts";

const url = process.env.BLAST_TEST_REDIS_URL;
const pepper = "synthetic-redis-test-pepper-01234567890123456789";

async function globalQuotaWindow(redis: ReturnType<typeof createRedisConnection>): Promise<number> {
  const reply = await redis.execute(["TIME"]);
  assert.ok(Array.isArray(reply) && typeof reply[0] === "string" && /^\d+$/.test(reply[0]));
  return Math.floor(Number(reply[0]) / 60);
}

test("DefiLlama reads share and enforce their Redis allowance across instances", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
}, async (t) => {
  assert.ok(url);
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname));
  const first = createRedisConnection(url, "quota");
  const second = createRedisConnection(url, "quota");
  t.after(() => { first.close(); second.close(); });
  const options = {
    namespace: `test:${randomUUID()}`,
    subjectPepper: pepper,
    policies: {
      ...DEFAULT_RATE_POLICIES,
      defillama_read: { ...DEFAULT_RATE_POLICIES.defillama_read, windows: [{ limit: 2, windowSeconds: 60 }] },
    },
  };
  const left = new RedisRateLimitEnforcer({ ...options, redis: first });
  const right = new RedisRateLimitEnforcer({ ...options, redis: second });
  const subject = { ip: "198.18.0.1" };
  assert.equal((await left.consume("defillama_read", subject)).allowed, true);
  assert.equal((await right.consume("defillama_read", subject)).allowed, true);
  const denied = await left.consume("defillama_read", subject);
  assert.equal(denied.allowed, false);
  assert.equal(denied.bucket, "defillama_read");
  assert.ok(denied.retryAfterSeconds > 0);
  assert.equal((await right.consume("defillama_read", { ip: "198.18.0.2" })).allowed, true);
  await assert.rejects(left.consume("presale_sponsor_global", {}), /restricted/);
});

test("real Redis shares atomic quotas across instances, preserves usage on policy changes and expires windows", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
}, async (t) => {
  assert.ok(url);
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Use a disposable loopback Redis");
  const first = createRedisConnection(url, "quota");
  const second = createRedisConnection(url, "quota");
  t.after(() => { first.close(); second.close(); });
  const namespace = `test:${randomUUID()}`;
  const metrics: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: string) => { metrics.push(JSON.parse(line)); });
  // Exercise the exact hosted INFO check against a real journal, without changing TLS requirements.
  await first.execute(["CONFIG", "SET", "appendonly", "yes"]);
  try {
    await verifyQuotaStorage(first, true);
  } finally {
    await first.execute(["CONFIG", "SET", "appendonly", "no"]);
  }
  await assert.rejects(verifyQuotaStorage(first, true), /journaling/);
  const policies = (minute: number, day: number, windowSeconds = 60) => ({
    ...DEFAULT_RATE_POLICIES,
    partner_read: { ...DEFAULT_RATE_POLICIES.partner_read,
      windows: [{ limit: minute, windowSeconds }, { limit: day, windowSeconds: 86_400 }] },
  });
  const limiter = (redis: typeof first, minute: number, day: number, windowSeconds = 60) =>
    new RedisRateLimitEnforcer({ redis, namespace, subjectPepper: pepper, policies: policies(minute, day, windowSeconds) });
  const left = limiter(first, 20, 25);
  const right = limiter(second, 20, 25);
  const subject = { apiKeyId: "key-a" };
  const calls = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    (index % 2 ? left : right).consume("partner_read", subject)));
  assert.equal(calls.filter((result) => result.allowed).length, 20);
  assert.ok(calls.filter((result) => !result.allowed).every((result) => result.retryAfterSeconds > 0));
  assert.equal((await left.consume("partner_read", { apiKeyId: "key-b" })).allowed, true);
  const raised = limiter(second, 25, 25);
  for (let index = 0; index < 5; index++) assert.equal((await raised.consume("partner_read", subject)).allowed, true);
  assert.equal((await raised.consume("partner_read", subject)).allowed, false);
  const lower = limiter(first, 1, 25);
  assert.equal((await lower.consume("partner_read", subject)).allowed, false);
  assert.equal((await limiter(first, 26, 26).consume("partner_read", subject)).allowed, true,
    "Denied requests never consumed the longer window");

  const short = limiter(first, 1, 2, 1);
  const shortSubject = { apiKeyId: "short-window" };
  assert.equal((await short.consume("partner_read", shortSubject)).allowed, true);
  await setTimeout(1_100);
  assert.equal((await short.consume("partner_read", shortSubject)).allowed, true);
  await setTimeout(1_100);
  const daily = await short.consume("partner_read", shortSubject);
  assert.equal(daily.allowed, false);
  assert.ok(daily.retryAfterSeconds > 1, "Daily exhaustion survives minute-window expiration");

  const combined = new RedisRateLimitEnforcer({ redis: first, namespace: `${namespace}:atomic`, subjectPepper: pepper,
    policies: { ...policies(2, 2), partner_read_global: { ...DEFAULT_RATE_POLICIES.partner_read_global,
      windows: [{ limit: 1, windowSeconds: 60 }] } } });
  assert.equal((await combined.consumeAll(["partner_read", "partner_read_global"], { apiKeyId: "atomic-a" })).allowed, true);
  assert.equal((await combined.consumeAll(["partner_read", "partner_read_global"], { apiKeyId: "atomic-b" })).allowed, false);
  assert.equal((await combined.consume("partner_read", { apiKeyId: "atomic-b" })).allowed, true);
  assert.equal((await combined.consume("partner_read", { apiKeyId: "atomic-b" })).allowed, true,
    "A global refusal did not spend this key's minute or day quota");
  assert.equal((await combined.consume("partner_read", { apiKeyId: "atomic-b" })).allowed, false);

  const isolated = new RedisRateLimitEnforcer({ redis: first, namespace: `${namespace}:preview`, subjectPepper: pepper });
  assert.equal((await isolated.consume("partner_read_global", {})).allowed, true);
  await assert.rejects(left.consume("presale_sponsor_global", {}), /restricted/);

  // Corruption must never reset spent allowances or partially charge another
  // window. Refuse this subject until an operator repairs it or its TTL expires.
  const corrupted = new RedisRateLimitEnforcer({ redis: first, namespace: `${namespace}:corrupted`, subjectPepper: pepper });
  await corrupted.consume("partner_read", { apiKeyId: "damaged" });
  const damagedKeys = await first.execute(["KEYS", `${namespace}:corrupted:*`]);
  assert.ok(Array.isArray(damagedKeys) && damagedKeys.length === 2);
  const intactKey = String(damagedKeys[1]);
  const intactValue = await first.execute(["GET", intactKey]);
  await first.execute(["SET", String(damagedKeys[0]), "invalid-counter", "KEEPTTL"]);
  await assert.rejects(corrupted.consume("partner_read", { apiKeyId: "damaged" }), /refused/);
  assert.ok(metrics.some((metric) => metric.metric === "redis.command" && metric.outcome === "counter_corrupt"
    && (metric.window === 1 || metric.window === 2)), "Corruption has a fixed, actionable window signal");
  assert.equal(await first.execute(["GET", intactKey]), intactValue);
  assert.equal((await corrupted.consume("partner_read", { apiKeyId: "unaffected" })).allowed, true);

  // An actual Redis write failure cannot grant admission or use another store.
  const priorKeys = await first.execute(["KEYS", `${namespace}:*`]);
  assert.ok(Array.isArray(priorKeys));
  assert.ok(priorKeys.every((key) => typeof key === "string" && !key.includes("key-a")));
  await first.execute(["CLIENT", "PAUSE", "700", "ALL"]);
  const started = performance.now();
  await assert.rejects(left.consume("partner_read", { apiKeyId: "timeout" }), /unavailable/);
  assert.ok(performance.now() - started < 1_000);
  let recovered = false;
  const deadline = performance.now() + 2_500;
  while (performance.now() < deadline) {
    try { recovered = (await left.consume("partner_read", { apiKeyId: "recovered" })).allowed; } catch { /* Keep traffic flowing throughout backoff. */ }
    if (recovered) break;
    await setTimeout(40);
  }
  assert.equal(recovered, true, "Refused traffic must not perpetually extend reconnect backoff");

  // A command error is not a dead transport, and must not affect another key.
  await assert.rejects(first.execute(["EVAL", "return redis.error_reply('test counter error')", "0"]), /refused/);
  assert.equal((await left.consume("partner_read", { apiKeyId: "unrelated" })).allowed, true);
  await first.execute(["SCRIPT", "FLUSH"]);
  const beforeReload = metrics.length;
  assert.equal((await left.consume("partner_read", { apiKeyId: "scripts-reloaded" })).allowed, true);
  assert.ok(metrics.slice(beforeReload).some((metric) => metric.metric === "redis.command" && metric.outcome === "script_missing"));
  assert.ok(!metrics.slice(beforeReload).some((metric) => metric.metric === "redis.command" && metric.outcome === "reply_error"),
    "A benign script-cache miss must not trigger the corruption/storage alarm");
  assert.equal((await left.consume("partner_read", { apiKeyId: "scripts-reloaded" })).allowed, true);

  // Replica replies cannot execute a write. Drop that socket, fail closed and
  // reconnect after the bounded backoff; never replay the refused command.
  for (const reply of ["READONLY", "MASTERDOWN"]) {
    await assert.rejects(first.execute(["EVAL", `return redis.error_reply('${reply} synthetic topology change')`, "0"]), /unavailable/);
    assert.ok(metrics.some((metric) => metric.metric === "redis.command" && metric.outcome === "replica_or_down"));
    await assert.rejects(first.execute(["PING"]), /unavailable/);
    await setTimeout(1_050);
    assert.equal(await first.execute(["PING"]), "PONG");
    assert.equal((await left.consume("partner_read", { apiKeyId: `reconnected-${reply}` })).allowed, true);
  }

  // The cache store must never be accepted for quotas.
  await first.execute(["CONFIG", "SET", "maxmemory-policy", "allkeys-lru"]);
  const misconfigured = createRedisConnection(url, "quota");
  try { await assert.rejects(misconfigured.execute(["PING"]), /unavailable/); }
  finally { misconfigured.close(); await first.execute(["CONFIG", "SET", "maxmemory-policy", "noeviction"]); }

});

test("the global partner quota admits exactly 600 concurrent requests in one Redis minute", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
}, async (t) => {
  assert.ok(url);
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Use a disposable loopback Redis");
  const connections = [createRedisConnection(url, "quota"), createRedisConnection(url, "quota")] as const;
  t.after(() => { for (const redis of connections) redis.close(); });

  // Only retry a burst that spans a Redis minute. Errors and wrong counts
  // within one minute fail immediately.
  for (let attempt = 0; attempt < 2; attempt++) {
    const namespace = `test:${randomUUID()}`;
    const limiters = connections.map((redis) => new RedisRateLimitEnforcer({ redis, namespace, subjectPepper: pepper }));
    const before = await globalQuotaWindow(connections[0]);
    let next = 0;
    let allowed = 0;
    await Promise.all(Array.from({ length: 32 }, async (_, worker) => {
      const limiter = limiters[worker % limiters.length]!;
      while (next++ < 900) {
        if ((await limiter.consume("partner_read_global", {})).allowed) allowed++;
      }
    }));
    if (await globalQuotaWindow(connections[0]) === before) {
      assert.equal(allowed, 600);
      return;
    }
  }
  assert.fail("Both global quota bursts crossed a Redis minute");
});


test("quota warmup coalesces connections and stops scheduling once ready", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
}, async (t) => {
  assert.ok(url);
  const connection = createRedisConnection(url, "quota");
  t.after(() => connection.close());
  const priorEpoch = connection.connectionEpoch();
  const warming = connection.warm();
  assert.ok(warming);
  for (let index = 0; index < 100; index++) assert.equal(connection.warm(), warming);
  await warming;
  const readyEpoch = connection.connectionEpoch();
  assert.ok(readyEpoch > priorEpoch);
  for (let index = 0; index < 100; index++) assert.equal(connection.warm(), undefined);
  assert.equal(connection.connectionEpoch(), readyEpoch, "Ordinary warm reads do not create a new epoch.");
  assert.equal(await connection.execute(["PING"]), "PONG");
});
