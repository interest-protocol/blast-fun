import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { routeLimitRefusal } from "./route-limits.ts";
import { testClient } from "../../../test/fixtures/lib/web-security/client-address.ts";
import { OperationalRateLimited } from "../../lib/web-security/rate-limits.ts";
import type { RateLimitPort } from "../../lib/web-security/rate-limits.ts";

test("memory-only route admission does not load the socket-backed traffic limiter", () => {
  const output = execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    let storageImports = 0;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith("/traffic-rate-limits.ts") || specifier === "@redis/client" || specifier === "pg") {
        storageImports++;
        throw new Error("Socket-backed traffic import blocked by the memory-only fixture");
      }
      return next(specifier, context);
    } });
    const { MemoryRateLimiter, sharedRouteLimiter } = await import(process.argv[1]);
    const limiter = new MemoryRateLimiter();
    assert.equal((await limiter.consume("partner_auth_ip", { ip: "198.18.0.1" })).allowed, true);
    assert.equal(await sharedRouteLimiter({}), null);
    await assert.rejects(sharedRouteLimiter({ RATE_LIMIT_SUBJECT_PEPPER: "p".repeat(31) }), /RATE_LIMIT_SUBJECT_PEPPER must be at least 32 characters/);
    assert.equal(storageImports, 0);
    await assert.rejects(sharedRouteLimiter({ RATE_LIMIT_SUBJECT_PEPPER: "synthetic-valid-pepper-at-least-32-characters" }), /Socket-backed traffic import blocked/);
    assert.equal(storageImports, 1, "The shared server limiter still resolves its real storage implementation");
    console.log("memory-only-admission-ok");
  `, new URL("./route-limits.ts", import.meta.url).href], { encoding: "utf8", timeout: 10_000 });
  assert.equal(output.trim(), "memory-only-admission-ok");
});

test("route limiters share a single instance across server bundles", async () => {
  const module = new URL("./route-limits.ts", import.meta.url);
  const first: typeof import("./route-limits.ts") = await import(`${module.href}?bundle=first`);
  const second: typeof import("./route-limits.ts") = await import(`${module.href}?bundle=second`);
  const environment = { RATE_LIMIT_SUBJECT_PEPPER: "synthetic-valid-pepper-at-least-32-characters" };

  assert.equal(first.instanceRouteLimiter(), second.instanceRouteLimiter());
  const [left, right] = await Promise.all([
    first.sharedRouteLimiter(environment),
    second.sharedRouteLimiter(environment),
  ]);
  assert.ok(left);
  assert.equal(left, right);
  assert.equal(await second.sharedRouteLimiter({}), null);
});

test("route admission uses one atomic decision for all buckets and fails closed", async () => {
  const buckets = ["partner_read", "partner_read_global"] as const;
  for (const outcome of ["allowed", "limited", "unavailable"] as const) {
    let calls = 0;
    const limiter: RateLimitPort = {
      async consume() { assert.fail("Atomic admission must never charge individual buckets"); },
      async consumeAll(actual, subject) {
        calls++;
        assert.deepEqual(actual, buckets);
        assert.equal(subject.apiKeyId, "synthetic-partner");
        if (outcome === "unavailable") throw new Error("Synthetic outage");
        return { allowed: outcome === "allowed", bucket: "partner_read_global", policyVersion: 1, retryAfterSeconds: 17 };
      },
    };
    const response = await routeLimitRefusal(testClient(), buckets, {
      limiter, subject: { apiKeyId: "synthetic-partner" },
    });
    assert.equal(calls, 1);
    assert.equal(response?.status ?? 200, outcome === "allowed" ? 200 : outcome === "limited" ? 429 : 503);
    if (outcome === "limited") assert.equal(response?.headers.get("Retry-After"), "17");
  }
});


test("operational quota refusal retains opaque 503 with its real window retry", async () => {
  for (const retry of [1, 37, 60]) {
    const response = await routeLimitRefusal(testClient(), ["partner_read"], {
      unavailable: "partner_api_unavailable",
      limiter: { async consume() { throw new OperationalRateLimited(retry); } },
    });
    assert.equal(response?.status, 503);
    assert.equal(response?.headers.get("Retry-After"), String(retry));
    assert.equal((await response!.json()).error.code, "partner_api_unavailable");
  }
  for (const invalid of [0, 61, 1.5, NaN])
    assert.throws(() => new OperationalRateLimited(invalid), TypeError);
});
