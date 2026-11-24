import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import { DEFAULT_RATE_POLICIES } from "@blast/core/lib/web-security/rate-limits.ts";
import { RedisRateLimitEnforcer } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { createOperatorRoutes } from "@blast/server/operators/routes.ts";
import { createAdminLoginAdmissionRoute } from "@blast/server/operators/login-admission.ts";
import { createBackendServer } from "../src/app/server.ts";

const secret = "synthetic-local-admission-secret-0123456789";
const operatorSecret = "synthetic-different-operator-token-0123456789";
const pepper = "synthetic-local-rate-pepper-01234567890123456789";

test(
  "real Redis and two Bun instances atomically share login budgets without touching commercial usage",
  { timeout: 30_000 },
  async (t) => {
    const url = process.env.BLAST_TEST_REDIS_URL;
    assert.ok(url, "Run with disposable loopback Redis; no silent skip");
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const leftRedis = createRedisConnection(url, "quota");
    const rightRedis = createRedisConnection(url, "quota");
    t.after(() => {
      leftRedis.close();
      rightRedis.close();
    });
    const namespace = randomUUID().replaceAll("-", "").repeat(2);
    const limiter = (redis: typeof leftRedis, policies = DEFAULT_RATE_POLICIES) =>
      new RedisRateLimitEnforcer({ redis, namespace, subjectPepper: pepper, policies });
    const left = limiter(leftRedis);
    const right = limiter(rightRedis);
    const operatorCalls: string[] = [];
    const runtime = (redis: typeof leftRedis, limits: RedisRateLimitEnforcer) => {
      const loginAdmission = createAdminLoginAdmissionRoute({
        secret,
        limiter: limits,
      });
      const operator = async (request: Request) => {
        operatorCalls.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      };
      const routes = createOperatorRoutes({
        "login-admission": loginAdmission,
        "partner-keys": operator,
        presales: operator,
        "bonding-feature": operator,
        "verified-mark": operator,
        "reward-coins": operator,
        "reward-blacklist": operator,
        "gas-pool-health": operator,
      });
      const server = createBackendServer({
        redis,
        namespace,
        gatewaySecret: "synthetic-gateway-secret-01234567890123456789",
        ready: async () => true,
        adminToken: operatorSecret,
        handle: async (request) => (await routes(request)) ?? new Response(null, { status: 404 }),
      });
      t.after(() => server.drain());
      return `http://127.0.0.1:${server.server.port}/api/admin/login-admission`;
    };
    const first = runtime(leftRedis, left);
    const second = runtime(rightRedis, right);
    const call = (
      target: string,
      ip = "192.0.2.1",
      token = secret,
      extra: Record<string, string> = {},
    ) =>
      fetch(target, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
        body: JSON.stringify({ clientAddress: ip }),
      });
    const keys = async (pattern: string): Promise<string[]> => {
      const all: string[] = [];
      let cursor = "0";
      do {
        const result = (await leftRedis.execute([
          "SCAN",
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          "100",
        ])) as [string, string[]];
        cursor = result[0];
        all.push(...result[1]);
      } while (cursor !== "0");
      return all.sort();
    };
    const snapshot = async (pattern: string) =>
      Object.fromEntries(
        await Promise.all(
          (await keys(pattern)).map(async (key) => [key, await leftRedis.execute(["GET", key])]),
        ),
      );
    // Exact real router composition: the admission credential never acquires operator authority.
    const beforeCredentials = await snapshot(`${namespace}:*:admin_login*`);
    for (const target of [first, second]) {
      const rejectedOperator = await call(target, "192.0.2.10", operatorSecret);
      assert.equal(rejectedOperator.status, 401);
      await rejectedOperator.body?.cancel();
      for (const path of [
        "/api/admin/partner-keys",
        "/api/admin/presales",
        "/api/admin/gas-pool/health",
        "/api/admin/reward-coins",
      ]) {
        const before = operatorCalls.length;
        const denied = await fetch(new URL(path, target), {
          headers: { authorization: `Bearer ${secret}` },
        });
        assert.equal(denied.status, 401);
        await denied.body?.cancel();
        assert.equal(
          operatorCalls.length,
          before,
          "Dedicated admission token cannot invoke an operator handler",
        );
        const allowed = await fetch(new URL(path, target), {
          headers: { authorization: `Bearer ${operatorSecret}` },
        });
        assert.equal(allowed.status, 204);
        assert.equal(operatorCalls.length, before + 1);
        assert.equal(operatorCalls.at(-1), path);
      }
    }
    assert.deepEqual(
      await snapshot(`${namespace}:*:admin_login*`),
      beforeCredentials,
      "Cross-token refusals do not consume attempts",
    );
    // Keep test requests within one real minute; do not move Redis time or alter TTLs.
    const clock = (await leftRedis.execute(["TIME"])) as string[];
    const remaining = 60 - (Number(clock[0]) % 60);
    if (remaining < 8) {
      await pause(remaining * 1000 + 20);
    }
    await left.consume("partner_read", { apiKeyId: "existing-key-id" });
    const paidBefore = await snapshot(`${namespace}:*:partner_read:*`);
    assert.equal(Object.keys(paidBefore).length, 2);
    for (let index = 0; index < 5; index++) {
      const response = await call(index % 2 ? second : first);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
    }
    const globalBeforeRefusal = await snapshot(`${namespace}:*:admin_login_global:*`);
    const denied = await call(second);
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get("retry-after")) > 0);
    assert.deepEqual(
      await snapshot(`${namespace}:*:admin_login_global:*`),
      globalBeforeRefusal,
      "IP refusal cannot partially spend global attempts",
    );
    const invalid = await call(first, "192.0.2.3", "wrong");
    assert.equal(invalid.status, 401);
    await invalid.body?.cancel();
    const browser = await call(first, "192.0.2.3", secret, { origin: "https://browser.test" });
    assert.equal(browser.status, 403);
    await browser.body?.cancel();
    assert.deepEqual(await snapshot(`${namespace}:*:admin_login_global:*`), globalBeforeRefusal);
    for (let index = 0; index < 95; index++) {
      const response = await call(index % 2 ? first : second, `198.51.100.${index + 1}`);
      assert.equal(response.status, 204);
    }
    const globalDenied = await call(first, "203.0.113.1");
    assert.equal(globalDenied.status, 429);
    assert.deepEqual(
      await snapshot(`${namespace}:*:partner_read:*`),
      paidBefore,
      "New admin budgets preserve all existing paid counters",
    );
    const adminKeys = await keys(`${namespace}:*:admin_login*`);
    for (const key of adminKeys) {
      const ttl = Number(await leftRedis.execute(["TTL", key]));
      assert.ok(ttl >= 0 && ttl <= 60, "Attempts expire naturally with their real window");
    }
    assert.ok(
      !(await keys(`${namespace}:*:admin_login_ip:*`)).some((key) => key.includes("203.0.113.1")),
      "Subjects are HMAC-derived",
    );
  },
);
