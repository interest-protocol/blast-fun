import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { RateBucket, RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { PARTNER_ENDPOINT_POLICIES } from "@blast/server/modules/partner-api-keys/runtime.ts";
import { createPartnerV1Read } from "@blast/server/modules/partner-api/v1/route.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

installRuntimeConfig();

function bindPartnerEndpointLimiter(limiter: RateLimitPort, keyId: string): RateLimitPort {
  if (!keyId) throw new Error("Verified partner key identity is required");
  return {
    consume(bucket, subject) {
      if (PARTNER_ENDPOINT_POLICIES[bucket].subjectScope !== "api_key") {
        throw new Error("Partner endpoint limiter is restricted to public reads");
      }
      return limiter.consume(bucket, { ...subject, apiKeyId: keyId });
    },
  };
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { createPartnerV1Handlers } = await import("@blast/server/modules/partner-api/v1/handlers.ts");
const id = `0x${"a".repeat(64)}`;
const cases: ReadonlyArray<readonly [string, RateBucket]> = [
  ["presales", "social_read_presales"],
  ["presales/featured", "social_read_presales"],
  [`presales/${id}`, "social_read_presales"],
  [`presales/${id}/proof?wallet=${id}`, "presale_proof"],
  ["prices", "social_read_prices"],
  ["market/status", "launchpad_market_status"],
  ["market/coins/0x2%3A%3Asui%3A%3ASUI/candles", "launchpad_market_candles"],
  ["market/coins/0x2%3A%3Asui%3A%3ASUI", "launchpad_market_coin"],
  ["market/coins/0x2%3A%3Asui%3A%3ASUI/metadata", "launchpad_market_coin"],
  ["market/coins/0x2%3A%3Asui%3A%3ASUI/holders", "launchpad_market_holders"],
  [`market/launches/${id}/activity`, "launchpad_market_activity"],
  [`market/pools/blast_curve/${id}`, "launchpad_market_pool"],
  [`market/pools/cetus/${id}`, "launchpad_market_pool"],
  [`market/pools/bluefin/${id}`, "launchpad_market_pool"],
  [`market/pools/blast_curve/${id}/candles`, "launchpad_market_candles"],
  [`market/pools/cetus/${id}/candles`, "launchpad_market_candles"],
  [`market/pools/bluefin/${id}/candles`, "launchpad_market_candles"],
  [`market/pools/cetus/${id}/trades`, "launchpad_market_trades"],
  [`market/pools/bluefin/${id}/trades`, "launchpad_market_trades"],
  ["discovery", "launchpad_discovery"],
  [`wallets/0x${"ab".repeat(32)}/launches`, "launchpad_wallet_launches"],
  ["search", "launchpad_search"],
  ["defillama/metadata", "defillama_read"],
  ["defillama/metrics", "defillama_read"],
  ["defillama/contracts", "defillama_read"],
];

test("endpoint budgets follow verified keys across IPs and isolate partners sharing a NAT", async () => {
  const limiter = new MemoryRateLimiter({ policies: {
    ...PARTNER_ENDPOINT_POLICIES,
    launchpad_search: { ...PARTNER_ENDPOINT_POLICIES.launchpad_search, windows: [{ limit: 1, windowSeconds: 60 }] },
  } });
  const first = bindPartnerEndpointLimiter(limiter, "verified-first");
  const second = bindPartnerEndpointLimiter(limiter, "verified-second");
  const subject = { ip: "198.18.0.1", apiKeyId: "forged" };
  assert.equal((await first.consume("launchpad_search", subject)).allowed, true);
  assert.equal((await second.consume("launchpad_search", subject)).allowed, true);
  assert.equal((await first.consume("launchpad_search", { ip: "198.18.0.2", apiKeyId: "new-forgery" })).allowed, false);
  assert.throws(() => bindPartnerEndpointLimiter(limiter, ""), /Verified/);
  assert.throws(() => first.consume("presale_sponsor_global", subject), /public reads/);
});

test("DeFiLlama routes use the real verified-key endpoint binding across IPs", async () => {
  assert.equal(PARTNER_ENDPOINT_POLICIES.defillama_read.subjectScope, "api_key");
  const limiter = new MemoryRateLimiter({ policies: {
    ...PARTNER_ENDPOINT_POLICIES,
    defillama_read: { ...PARTNER_ENDPOINT_POLICIES.defillama_read, windows: [{ limit: 1, windowSeconds: 60 }] },
  } });
  const bound = (key: string) => createPartnerV1Read(createPartnerV1Handlers(bindPartnerEndpointLimiter(limiter, key)));
  const first = bound("verified-defillama-first");
  const second = bound("verified-defillama-second");
  const request = (path: string) => new Request(`https://www.blast.fun/api/v1/defillama/${path}`, {
    headers: { "x-blast-api-key-id": "untrusted-client-value" },
  });
  // Missing date reaches real product validation without invoking the reporting database.
  const accepted = await first(request("metrics"), testClient("198.18.0.1"));
  assert.equal(accepted.status, 400);
  assert.deepEqual(await accepted.json(), { error: { code: "missing_date" } });
  assert.equal((await second(request("metrics"), testClient("198.18.0.1"))).status, 400, "Another verified key behind the same NAT has its own endpoint budget");
  assert.equal((await first(request("contracts"), testClient("198.18.0.2"))).status, 429, "Changing IP or endpoint cannot reset the verified key's bucket");
  assert.equal((await first(request("metadata"), testClient("198.18.0.3"))).status, 429);
});

for (const unavailable of [false, true]) {
  test(`every v1 service uses the real verified-key binding and fails ${unavailable ? "closed" : "at quota"} before product reads`, async () => {
    const buckets: RateBucket[] = [];
    const limiter: RateLimitPort = {
      async consume(bucket, subject) {
        buckets.push(bucket);
        assert.equal(subject.ip, "198.18.0.1");
        assert.equal(subject.apiKeyId, "verified-every-route");
        if (unavailable) throw new Error("Database unavailable");
        return { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 7 };
      },
    };
    const read = createPartnerV1Read(createPartnerV1Handlers(bindPartnerEndpointLimiter(limiter, "verified-every-route")));
    for (const [path] of cases) {
      const response = await read(new Request(`https://www.blast.fun/api/v1/${path}`, {
        headers: { "x-forwarded-for": "198.18.0.1", "x-blast-api-key-id": "forged-client-value" },
      }), testClient("198.18.0.1"));
      assert.equal(response.status, unavailable ? 503 : 429, path);
      assert.ok(Number(response.headers.get("retry-after")) > 0, path);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.deepEqual(buckets, cases.map(([, bucket]) => bucket));
  });
}
