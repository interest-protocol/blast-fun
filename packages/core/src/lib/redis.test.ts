import assert from "node:assert/strict";
import test from "node:test";
import net, { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { configuredRedis, createRedisConnection, RedisNotReady, redisNamespace, verifyQuotaStorage } from "./redis.ts";
import { OperationalRateLimited, RedisRateLimitEnforcer } from "./web-security/redis-rate-limits.ts";
import { createPublicReadCache } from "./public-read-cache.ts";

test("optional cache refuses the hosted quota endpoint even with different URL credentials or defaults", (t) => {
  const metrics: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: string) => { metrics.push(JSON.parse(line)); });
  const cacheSlot = Symbol.for("blast.redis.cache");
  const previousCache = Reflect.get(globalThis, cacheSlot);
  Reflect.deleteProperty(globalThis, cacheSlot);
  const previous = { BLAST_QUOTA_REDIS_URL: process.env.BLAST_QUOTA_REDIS_URL, BLAST_CACHE_REDIS_URL: process.env.BLAST_CACHE_REDIS_URL };
  t.after(() => {
    if (previousCache === undefined) Reflect.deleteProperty(globalThis, cacheSlot);
    else Reflect.set(globalThis, cacheSlot, previousCache);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.BLAST_QUOTA_REDIS_URL = "rediss://quota:private@quota.example:6379/0";
  for (const cacheUrl of ["rediss://cache:other@quota.example", "rediss://quota:private@quota.example:6379/0"]) {
    process.env.BLAST_CACHE_REDIS_URL = cacheUrl;
    assert.equal(configuredRedis("cache"), null);
  }
  assert.equal(metrics.length, 2);
  assert.ok(metrics.every((metric) => metric.outcome === "shared_store_refused" && metric.purpose === "cache"));
  assert.ok(!JSON.stringify(metrics).includes("private"));
  process.env.BLAST_QUOTA_REDIS_URL = "rediss://red-aaaaaaaaaaaaaaaaaaaa:private@virginia-keyvalue.render.com:6379";
  for (const cacheUrl of [
    "rediss://red-aaaaaaaaaaaaaaaaaaaa:other@virginia-keyvalue.render.com/0",
    "rediss://default:other@virginia-keyvalue.render.com",
    "rediss://red-short:other@virginia-keyvalue.render.com",
  ]) {
    process.env.BLAST_CACHE_REDIS_URL = cacheUrl;
    assert.equal(configuredRedis("cache"), null, "Same service or unrecognized ACL identity must remain refused");
  }
  process.env.BLAST_QUOTA_REDIS_URL = "rediss://red-aaaaaaaaaaaaaaaaaaaa:private@virginia-keyvalue.render.com.attacker.example";
  process.env.BLAST_CACHE_REDIS_URL = "rediss://red-bbbbbbbbbbbbbbbbbbbb:other@virginia-keyvalue.render.com.attacker.example";
  assert.equal(configuredRedis("cache"), null, "Only Render's exact shared proxy domain uses service routing");
  process.env.BLAST_QUOTA_REDIS_URL = "rediss://red-aaaaaaaaaaaaaaaaaaaa:private@virginia-keyvalue.render.com";
  process.env.BLAST_CACHE_REDIS_URL = "rediss://red-bbbbbbbbbbbbbbbbbbbb:other@virginia-keyvalue.render.com:6379/0";
  const renderCache = configuredRedis("cache");
  assert.ok(renderCache, "Distinct Render services may share their regional external proxy");
  renderCache.close();
  Reflect.deleteProperty(globalThis, cacheSlot);
  process.env.BLAST_CACHE_REDIS_URL = "rediss://cache:other@separate.example:6379/0";
  const separate = configuredRedis("cache");
  assert.ok(separate);
  assert.notEqual(separate, renderCache, "Each case constructs its own configured connection");
  separate.close();
});

test("Redis requires TLS and authentication outside loopback, without leaking invalid URLs", () => {
  for (const url of ["redis://private.example:6379", "rediss://host:6379", "rediss://user:secret@host/2", "rediss://user:secret@host?password=secret"]) {
    assert.throws(() => createRedisConnection(url, "quota"), (error: unknown) =>
      error instanceof Error && !error.message.includes("secret") && /TLS/.test(error.message));
  }
  for (const url of ["redis://127.0.0.1:6379", "rediss://user:secret@host:6379"]) {
    createRedisConnection(url, "cache").close();
  }
  assert.equal(redisNamespace("blast:mainnet:production:v1"), "blast:mainnet:production:v1");
  for (const value of [undefined, "", "../production", "a".repeat(129)]) {
    assert.throws(() => redisNamespace(value));
  }
});

test("Redis quota failures and malformed decisions cannot admit traffic", async () => {
  for (const reply of [null, [1], [1, 0], [1, 1, 0], [0, 0, 1], [0, -1, 1], [1, "0", 0], [0, 90_000, 1], [0, 1, 0], [0, 1, 2]]) {
    const limiter = new RedisRateLimitEnforcer({ redis: { execute: async () => reply }, namespace: "test", subjectPepper: "p".repeat(32) });
    await assert.rejects(limiter.consume("partner_read", { apiKeyId: "a" }), /Invalid/);
  }
  const limiter = new RedisRateLimitEnforcer({ redis: { execute: async () => { throw new Error("unavailable"); } }, namespace: "test", subjectPepper: "p".repeat(32) });
  await assert.rejects(limiter.consume("partner_read", { apiKeyId: "a" }), /unavailable/);
});


test("quota stores reject eviction and missing hosted journals before traffic", async () => {
  const storage = (memory: unknown, persistence: unknown) => ({ execute: async (args: string[]) => args[1] === "memory" ? memory : persistence });
  await verifyQuotaStorage(storage("# Memory\r\nmaxmemory_policy:noeviction\r\n", "aof_enabled:1\r\n"), true);
  for (const memory of [null, "", "maxmemory_policy:allkeys-lru\r\n"]) {
    await assert.rejects(verifyQuotaStorage(storage(memory, "aof_enabled:1"), true), /evict/);
  }
  for (const journal of [null, "", "aof_enabled:0\r\n"]) {
    await assert.rejects(verifyQuotaStorage(storage("maxmemory_policy:noeviction", journal), true), /journaling/);
  }
  await verifyQuotaStorage(storage("maxmemory_policy:noeviction", null), false);
});

test("a hanging optional cache connection never delays source reads", async (t) => {
  const background: Promise<unknown>[] = [];
  const requestContext = Symbol.for("@vercel/request-context");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const previous = globals[requestContext];
  globals[requestContext] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => background.push(promise) }) };
  t.after(() => { globals[requestContext] = previous; });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const accepted = once(server, "connection");
  const cache = createRedisConnection(`redis://127.0.0.1:${address.port}`, "cache");
  t.after(() => { cache.close(); for (const socket of sockets) socket.destroy(); server.close(); });
  let loads = 0;
  const read = createPublicReadCache(cache, "hanging-test", "s".repeat(32));
  const results = await Promise.all(Array.from({ length: 100 }, () => read("optional", async () => ++loads, 1_000)));
  assert.equal(loads, 1);
  assert.deepEqual(results, Array(100).fill(1));
  assert.ok(background.length > 0, "The originating request must retain background connection work");
  assert.equal(new Set(background).size, 1, "Concurrent reads retain one coalesced warmup");
  const pending = Symbol("pending");
  assert.equal(await Promise.race([background[0], pending]), pending, "Source reads must finish while cache warmup is pending");
  await accepted;
  assert.equal(sockets.size, 1);
  await Promise.all(background);
  assert.equal(cache.warm(), undefined, "Failure backoff must not schedule more background work");
});

test("cache warming metrics are sampled while actual failures remain visible", async (t) => {
  const metrics: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: string) => { metrics.push(JSON.parse(line)); });
  t.mock.method(Math, "random", () => 0.5);
  const warm = createPublicReadCache({ execute: async () => { throw new RedisNotReady(); } }, "test", "s".repeat(32));
  assert.equal(await warm("a", async () => 1, 1_000), 1);
  assert.equal(metrics.length, 0);
  t.mock.method(Math, "random", () => 0);
  assert.equal(await warm("b", async () => 2, 1_000), 2);
  assert.ok(metrics.some((metric) => metric.outcome === "warming" && metric.sampleRate === 0.02));
  const failed = createPublicReadCache({ execute: async () => { throw new Error("storage failure"); } }, "test", "s".repeat(32));
  assert.equal(await failed("c", async () => 3, 1_000), 3);
  assert.ok(metrics.some((metric) => metric.outcome === "unavailable" && metric.sampleRate === undefined));
});


test("hanging quota warming records a fixed failure, settles at its deadline and retries after backoff", async (t) => {
  const metrics: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (line: string) => { metrics.push(JSON.parse(line)); });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const quota = createRedisConnection(`redis://127.0.0.1:${address.port}`, "quota");
  t.after(() => { quota.close(); for (const socket of sockets) socket.destroy(); server.close(); });
  const before = performance.now();
  const warming = quota.warm();
  assert.ok(warming);
  await warming;
  assert.ok(performance.now() - before < 3_500, "A warm deadline must settle request retention");
  assert.equal(quota.warm(), undefined, "Backoff must not start another connection");
  assert.ok(metrics.some((metric) => metric.purpose === "quota" && metric.outcome === "connect_failed"));
  assert.ok(!JSON.stringify(metrics).includes("127.0.0.1"), "Connection diagnostics never include endpoint details");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const accepted = once(server, "connection");
  const retry = quota.warm();
  assert.ok(retry);
  assert.notEqual(retry, warming);
  const [socket] = await accepted;
  socket.destroy();
  await retry;
});


test("quota commands recover when a socket connects after its deadline", { timeout: 8_000 }, async (t) => {
  const sockets: Duplex[] = [];
  const memoryInfo = "maxmemory_policy:noeviction\r\n";
  const replies = new Map([
    ["INFO", `$${Buffer.byteLength(memoryInfo)}\r\n${memoryInfo}\r\n`],
    ["PING", "+PONG\r\n"],
  ]);
  t.mock.method(net, "createConnection", () => {
    const socket = new Duplex({
      read() {},
      writev(chunks, callback) {
        // node-redis writes a complete batch of RESP commands while corked.
        const batch = Buffer.concat(chunks.map(({ chunk }) => chunk)).toString();
        for (const command of batch.split(/\*(?=\d+\r\n)/).slice(1)) {
          const [, , name] = command.split("\r\n");
          const reply = replies.get(name) ?? "+OK\r\n";
          setImmediate(() => socket.push(reply));
        }
        callback();
      },
    });
    // Let Blast's own deadline fire while the transport is still connecting.
    const transport = Object.assign(socket, { setTimeout: () => socket });
    sockets.push(socket);
    if (sockets.length > 1) queueMicrotask(() => socket.emit("connect"));
    return transport;
  });

  const quota = createRedisConnection("redis://127.0.0.1:1", "quota");
  t.after(() => {
    quota.close();
    for (const socket of sockets) socket.destroy();
  });

  await assert.rejects(quota.execute(["PING"]), /Redis operation unavailable/);
  const [timedOutSocket] = sockets;
  assert.ok(timedOutSocket);
  timedOutSocket.emit("connect");
  await delay(1_100);

  assert.equal(await quota.execute(["PING"]), "PONG");
  assert.equal(sockets.length, 2);
});

test("private replay has a distinct durable connection using the existing quota URL", (t) => {
  const purposes = ["quota", "private-replay"] as const;
  const slots = purposes.map((purpose) => Symbol.for(`blast.redis.${purpose}`));
  const previous = slots.map((slot) => Reflect.get(globalThis, slot));
  const previousUrl = process.env.BLAST_QUOTA_REDIS_URL;
  slots.forEach((slot) => Reflect.deleteProperty(globalThis, slot));
  process.env.BLAST_QUOTA_REDIS_URL = "rediss://synthetic:synthetic@quota.example";
  t.after(() => {
    slots.forEach((slot, index) => {
      if (previous[index] === undefined) Reflect.deleteProperty(globalThis, slot);
      else Reflect.set(globalThis, slot, previous[index]);
    });
    if (previousUrl === undefined) delete process.env.BLAST_QUOTA_REDIS_URL;
    else process.env.BLAST_QUOTA_REDIS_URL = previousUrl;
  });
  const quota = configuredRedis("quota")!;
  const replay = configuredRedis("private-replay")!;
  assert.notEqual(quota, replay);
  assert.equal(replay, configuredRedis("private-replay"));
  quota.close(); replay.close();
  assert.throws(() => createRedisConnection("redis://quota.example", "private-replay"), /TLS/);
});


test("operational quota refusal preserves Redis retry and leaves commercial denial distinct", async () => {
  const limiter = (reply: number[]) => new RedisRateLimitEnforcer({
    redis: { execute: async () => reply }, namespace: "test", subjectPepper: "p".repeat(32),
  });
  await assert.rejects(limiter([0, 37, 2]).consumeAllWithOperational(["partner_read"], { apiKeyId: "synthetic" }, {
    key: "test:{partner-quota}:recognition-admission:tenant:" + "a".repeat(64), limit: 1,
  }), (error) => error instanceof OperationalRateLimited && error.retryAfterSeconds === 37);
  const commercial = await limiter([0, 37, 1]).consumeAllWithOperational(["partner_read"], { apiKeyId: "synthetic" }, {
    key: "test:{partner-quota}:recognition-admission:tenant:" + "a".repeat(64), limit: 1,
  });
  assert.equal(commercial?.allowed, false);
  assert.equal(commercial?.bucket, "partner_read");
  assert.equal(commercial?.retryAfterSeconds, 37);
});
