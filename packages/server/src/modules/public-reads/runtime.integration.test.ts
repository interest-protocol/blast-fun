import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { configuredRedis } from "@blast/core/lib/redis.ts";
import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";

const url = process.env.BLAST_TEST_REDIS_URL;

test("the public read factory uses Redis and reports invalid configuration before falling back", {
  skip: url ? false : "BLAST_TEST_REDIS_URL is not set",
}, async (t) => {
  assert.ok(url);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const overrides = {
    BLAST_CACHE_REDIS_URL: url, BLAST_REDIS_NAMESPACE: `runtime:${randomUUID()}`,
    DATABASE_REPLICA_URL: "postgresql://reader:synthetic@127.0.0.1/test",
    // The released deployment, so the namespace hashes a ready presale identity.
    BLAST_DEPLOYMENT_FINGERPRINT: deploymentFingerprint(BLAST_DEPLOYMENTS.mainnet!),
    MISSION_CONTROL_METRICS: "on",
  };
  installRuntimeConfig(overrides);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : next(specifier, context);
  } });
  const redis = configuredRedis("cache")!;
  t.after(() => {
    redis.close(); hooks.deregister();
    for (const scope of ["presales", "prices"]) Reflect.deleteProperty(globalThis, Symbol.for(`blast.public-read-cache.${scope}`));
    Reflect.deleteProperty(globalThis, Symbol.for("blast.redis.cache"));
  });
  for (let attempt = 0; ; attempt++) {
    try { await redis.execute(["PING"]); break; }
    catch (error) { if (attempt >= 100) throw error; await setTimeout(10); }
  }
  const commands: string[] = [];
  const execute = redis.execute.bind(redis);
  t.mock.method(redis, "execute", async (args: string[]) => { commands.push(args[0]!); return execute(args); });
  const { publicReadCache } = await import("@blast/server/modules/public-reads/shared-runtime.ts");
  const read = publicReadCache("presales");
  let loads = 0;
  assert.equal(await read("factory", async () => ++loads, 1_000), 1);
  assert.equal(await read("factory", async () => ++loads, 1_000), 1);
  assert.ok(commands.includes("GET"));
  // This fails if a cache without its namespace (no replica, no deployment identity) served from Redis.
  installRuntimeConfig(overrides, { publicReadNamespaces: null });
  const messages: string[] = [];
  t.mock.method(console, "info", (message: string) => { messages.push(message); });
  const fallback = publicReadCache("prices");
  assert.equal(await fallback("fallback", async () => 7, 1_000), 7);
  assert.ok(messages.some((message) => {
    const metric = JSON.parse(message);
    return metric.metric === "public_read.cache" && metric.outcome === "configuration_unavailable";
  }));
});
