import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { createPublicReadCache } from "./public-read-cache.ts";
import { createRedisConnection, type RedisCommands } from "./redis.ts";

async function alterEnvelope(redis: RedisCommands, keys: string[], containing: string, patch: Record<string, unknown>) {
  for (const key of keys.filter((key) => !key.endsWith(":loading"))) {
    const raw = await redis.execute(["GET", key]);
    if (typeof raw !== "string" || !raw.includes(containing)) continue;
    await redis.execute(["SET", key, JSON.stringify({ ...JSON.parse(raw), ...patch }), "PX", "60000"]);
  }
}

const url = process.env.BLAST_TEST_REDIS_URL;

/** Real TCP transport: once blocked, accepted sockets consume bytes but never answer. */
async function blackholeProxy(target: URL) {
  let blocked = false;
  let accepted = 0;
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    accepted++;
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    for (const [source, destination] of [[downstream, upstream], [upstream, downstream]]) {
      sockets.add(source);
      source.on("data", (data) => { if (!blocked) destination.write(data); });
      source.on("error", () => destination.destroy());
      source.on("close", () => { sockets.delete(source); destination.destroy(); });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxyUrl = new URL(target);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(address.port);
  return {
    url: proxyUrl.href,
    block(value: boolean) { blocked = value; },
    accepted: () => accepted,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("an established cache TCP blackhole costs one command deadline, then distinct reads fail fast and recover", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
  timeout: 12_000,
}, async (t) => {
  assert.ok(url);
  const target = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  const proxy = await blackholeProxy(target);
  const connection = createRedisConnection(proxy.url, "cache");
  t.after(async () => { connection.close(); await proxy.close(); });
  await connection.warm();
  assert.equal(await connection.execute(["PING"]), "PONG", "Start with an established, responsive connection");
  const read = createPublicReadCache(connection, `blackhole:${randomUUID()}`, "s".repeat(32));
  let loads = 0;
  const source = async () => ({ sequence: ++loads });
  proxy.block(true);
  const started = performance.now();
  assert.deepEqual(await read("first", source, 1_000), { sequence: 1 });
  const firstMs = performance.now() - started;
  assert.ok(firstMs >= 400 && firstMs < 900, `First blackholed command must reach its 500 ms deadline: ${firstMs} ms`);

  async function distinctReads(prefix: string) {
    const samples: number[] = [];
    const before = performance.now();
    for (let index = 0; index < 20; index++) {
      const start = performance.now();
      const expected = loads + 1;
      assert.deepEqual(await read(`${prefix}:${index}`, source, 1_000), { sequence: expected });
      samples.push(performance.now() - start);
    }
    assert.ok(performance.now() - before < 200, "Distinct fallback reads must not each pay a 500 ms deadline");
    samples.sort((a, b) => a - b);
    const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
    assert.ok(p95Ms < 100, `Sequential distinct-key fallback p95: ${p95Ms} ms`);
    return p95Ms;
  }
  const backoffP95Ms = await distinctReads("backoff");
  assert.equal(proxy.accepted(), 1, "Backoff must not create connections per request");
  assert.equal(connection.warm(), undefined);
  await setTimeout(1_100);
  const reconnect = connection.warm();
  assert.ok(reconnect, "Backoff permits one new background connection attempt");
  const reconnectP95Ms = await distinctReads("reconnecting");
  const reconnectStarted = performance.now();
  await reconnect;
  assert.ok(performance.now() - reconnectStarted < 3_500, "A blackholed handshake must settle at its connection deadline");
  assert.equal(proxy.accepted(), 2);
  assert.equal(connection.warm(), undefined, "Failed reconnect reenters backoff");

  proxy.block(false);
  await setTimeout(1_100);
  await connection.warm();
  assert.equal(await connection.execute(["PING"]), "PONG");
  const recovered = await read("recovered", source, 1_000);
  assert.deepEqual(await read("recovered", source, 1_000), recovered);
  assert.equal(loads, 42, "Forty-one distinct outage reads load sources; recovery retains its one source result");
  t.diagnostic(JSON.stringify({ firstMs, backoffP95Ms, reconnectP95Ms, loads, connections: proxy.accepted() }));
});

test("repeated successful cache handshakes followed by command loss cost one deadline per sequential read cycle", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
  timeout: 20_000,
}, async (t) => {
  assert.ok(url);
  const target = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  const proxy = await blackholeProxy(target);
  const connection = createRedisConnection(proxy.url, "cache");
  t.after(async () => { connection.close(); await proxy.close(); });
  const read = createPublicReadCache(connection, `flapping:${randomUUID()}`, "s".repeat(32));
  let loads = 0;
  const source = async () => ({ sequence: ++loads });
  const cycles: { cycle: number; firstMs: number; fallbackP95Ms: number; slowReads: number }[] = [];

  for (let cycle = 0; cycle < 5; cycle++) {
    if (cycle > 0) await setTimeout(1_100);
    proxy.block(false);
    await connection.warm();
    assert.equal(await connection.execute(["PING"]), "PONG", "Each fresh handshake must complete before commands are dropped");
    assert.equal(proxy.accepted(), cycle + 1);
    proxy.block(true);
    const samples: number[] = [];
    for (let index = 0; index < 21; index++) {
      const started = performance.now();
      const expected = loads + 1;
      assert.deepEqual(await read(`${cycle}:${index}`, source, 1_000), { sequence: expected });
      samples.push(performance.now() - started);
    }
    const slowReads = samples.filter((sample) => sample >= 400).length;
    assert.equal(slowReads, 1, `Cycle ${cycle}: only the first sequential read may pay a command deadline`);
    assert.ok(samples[0] >= 400 && samples[0] < 1_500, `Cycle ${cycle}: expected the bounded 500 ms command deadline, got ${samples[0]} ms`);
    const fallback = samples.slice(1).sort((a, b) => a - b);
    const fallbackP95Ms = fallback[Math.ceil(fallback.length * 0.95) - 1];
    assert.ok(fallbackP95Ms < 100, `Cycle ${cycle}: backoff fallback p95 was ${fallbackP95Ms} ms`);
    assert.equal(connection.warm(), undefined, "A failed established connection must reenter cooldown");
    cycles.push({ cycle, firstMs: samples[0], fallbackP95Ms, slowReads });
  }

  proxy.block(false);
  await setTimeout(1_100);
  await connection.warm();
  const recovered = await read("recovered", source, 1_000);
  assert.deepEqual(await read("recovered", source, 1_000), recovered);
  assert.equal(loads, 106, "All 105 distinct outage reads load sources; recovered caching retains its one result");
  assert.equal(proxy.accepted(), 6, "Five completed handshake/drop cycles and one recovery connection");
  t.diagnostic(JSON.stringify({ cycles, loads, connections: proxy.accepted() }));
});

test("real Redis coalesces public reads across instances, expires values, isolates environments and never retains errors", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
  timeout: 15_000,
}, async (t) => {
  assert.ok(url);
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
  const connection = createRedisConnection(url, "cache");
  const otherConnection = createRedisConnection(url, "cache");
  t.after(() => { connection.close(); otherConnection.close(); });
  // Cold optional cache connections warm without delaying product reads.
  for (const client of [connection, otherConnection]) {
    for (let attempt = 0; ; attempt++) {
      try { await client.execute(["PING"]); break; }
      catch (error) { if (attempt >= 100) throw error; await setTimeout(10); }
    }
  }
  const namespace = `cache-test:${randomUUID()}`;
  const first = createPublicReadCache(connection, namespace, "s".repeat(32));
  const second = createPublicReadCache(otherConnection, namespace, "s".repeat(32));
  let loads = 0;
  const load = async () => { loads++; await setTimeout(75); return { amount: "12345678901234567890", as_of: 123 }; };
  const results = await Promise.all(Array.from({ length: 80 }, (_, index) => (index % 2 ? first : second)("list:a", load, 500)));
  assert.equal(loads, 1);
  assert.ok(results.every((result) => result.amount === "12345678901234567890"));
  await second("list:a", load, 500);
  assert.equal(loads, 1);
  await setTimeout(550);
  await first("list:a", load, 500);
  assert.equal(loads, 2);
  await createPublicReadCache(connection, `${namespace}:preview`, "s".repeat(32))("list:a", load, 500);
  assert.equal(loads, 3);

  let failed = 0;
  const fail = async () => { failed++; throw new Error("Source unavailable"); };
  await assert.rejects(first("failure", fail, 1_000), /Source unavailable/);
  await assert.rejects(second("failure", fail, 1_000), /Source unavailable/);
  assert.equal(failed, 2);
  let missing = 0;
  const negative = async () => { missing++; return null; };
  await first("missing", negative, 1_000);
  await second("missing", negative, 1_000);
  assert.equal(missing, 2);
  let fresh = 0;
  assert.equal(await first("detail", async () => ++fresh, 0), 1);
  assert.equal(await second("detail", async () => ++fresh, 0), 2);

  // A lock expiring or being replaced cannot allow an older writer to overwrite its successor.
  let release!: (value: string) => void;
  const old = first("race", () => new Promise<string>((resolve) => { release = resolve; }), 1_000);
  while (!release) await setTimeout(5);
  const locks = await connection.execute(["KEYS", `${namespace}:*:loading`]);
  assert.ok(Array.isArray(locks));
  await connection.execute(["DEL", ...locks]);
  assert.equal(await second("race", async () => "new", 1_000), "new");
  release("old");
  assert.equal(await old, "old");
  assert.equal(await first("race", async () => "unexpected", 1_000), "new");

  // Cache writers without the application MAC key cannot forge or extend a body.
  await first("tamper", async () => "trusted", 1_000);
  const cacheKeys = await connection.execute(["KEYS", `${namespace}:public:v2:*`]) as string[];
  await alterEnvelope(connection, cacheKeys, "trusted", { payload: JSON.stringify("forged") });
  assert.equal(await second("tamper", async () => "reloaded", 1_000), "reloaded");
  await alterEnvelope(connection, cacheKeys, "reloaded", { expiresAt: Date.now() + 60_000 });
  assert.equal(await first("tamper", async () => "expiry-verified", 1_000), "expiry-verified");
  // Another application's key cannot authenticate this envelope.
  const wrongKey = createPublicReadCache(connection, namespace, "different-key".repeat(4));
  assert.equal(await wrongKey("tamper", async () => "isolated", 1_000), "isolated");

  const oversized = "a".repeat(600_000);
  assert.equal(await first("large", async () => oversized, 1_000), oversized);
  assert.equal(await second("large", async () => "not-cached", 1_000), "not-cached");

  for (const failure of [false, true]) {
    // A released error/null writer must not leave another instance polling for
    // the full second. Observe real contention before letting that writer finish.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let contended!: () => void;
    const contention = new Promise<void>((resolve) => { contended = resolve; });
    const waiter = createPublicReadCache({ execute: async (args) => {
      const result = await otherConnection.execute(args);
      if (args[0] === "SET" && result === null) contended();
      return result;
    } }, namespace, "s".repeat(32));
    const key = `recovery:${failure}`;
    const entered = Promise.withResolvers<void>();
    const firstResult = first(key, async () => {
      entered.resolve();
      await gate;
      if (failure) throw new Error("Synthetic unavailable source");
      return null;
    }, 1_000).catch((error: unknown) => error);
    await entered.promise;
    const recovered = waiter(key, async () => "recovered", 1_000);
    await contention;
    const started = performance.now();
    release();
    const initial = await firstResult;
    assert.ok(failure ? initial instanceof Error : initial === null);
    assert.equal(await recovered, "recovered");
    assert.ok(performance.now() - started < 400, "Released Redis leases should recover on the next poll");
  }
});

test("cache outages fall back to one coalesced source read per process", async () => {
  let loads = 0;
  const read = createPublicReadCache({ execute: async () => { throw new Error("Redis down"); } }, "test", "s".repeat(32));
  const result = await Promise.all(Array.from({ length: 40 }, () => read("list", async () => ++loads, 10_000)));
  assert.deepEqual(result, Array(40).fill(1));
  assert.equal(await read("list", async () => ++loads, 10_000), 2);
  await assert.rejects(read("invalid-ttl", async () => 1, 10_001), /TTL/);
});
