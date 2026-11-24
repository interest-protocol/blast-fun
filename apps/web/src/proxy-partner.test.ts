import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { isPartnerRequest, PARTNER_KEY_HEADER } from "@blast/core/modules/backend-api/partner-http.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { partnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";
import { isRegionalPartnerRead, partnerV1Route } from "@blast/server/modules/partner-api/v1/paths.ts";
import { createSocialPricesRoute } from "@blast/server/modules/social/prices/route.ts";

/**
 * The frontend proxy's part of partner reads: it forwards exact v1 reads to the backend relay
 * without looking up a key, and refuses aliases, private paths and writes itself. Admission
 * (keys, origins, quotas, preflights) belongs to the backend and is tested there.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const KEY = `blast_pk_${"a".repeat(43)}`;
const ORIGIN = "https://partner.example";
const PATH = "/api/v1/presales";
const ID = `0x${"a".repeat(64)}`;
const URL_V1 = `https://www.blast.fun${PATH}`;

function request(path = PATH, headers: HeadersInit = {}, method = "GET"): Request {
  return new Request(`https://www.blast.fun${path}`, {
    method, headers: { [PARTNER_KEY_HEADER]: KEY, "x-forwarded-for": "198.18.0.1", ...headers },
  });
}

function preflight(path: string): Request {
  return new Request(`https://www.blast.fun${path}`, { method: "OPTIONS", headers: {
    origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "X-Blast-Partner-Key",
  } });
}

function noStore(response: Response) {
  for (const header of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control"]) {
    assert.ok(response.headers.get(header)?.includes("no-store"), header);
  }
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("Proxy delegates exact v1 reads and the application fails closed without its backend", async (t) => {
  const verify = t.mock.method(partnerKeyReader, "verify", async () => { throw new Error("No proxy key lookup expected"); });
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("#web/proxy.ts");
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const input = new NextRequest(request(PATH, { [PARTNER_KEY_HEADER]: "invalid", "x-blast-partner-authorized": "1",
      cookie: "team=private", authorization: "Bearer private", "x-blast-api-key": "private",
      "x-blast-home-rewrite": "1", "x-blast-profile-rewrite": "1" }, method));
    assert.equal(isRegionalPartnerRead(input), true);
    const response = await proxy(input);
    assert.equal(response.headers.get("x-middleware-next"), "1");
    const forwarded = response.headers.get("x-middleware-override-headers")?.split(",");
    assert.equal(forwarded?.filter((name) => name === PARTNER_KEY_HEADER).length, 1);
    assert.equal(response.headers.get(`x-middleware-request-${PARTNER_KEY_HEADER}`), "invalid");
    assert.equal(response.headers.get("x-middleware-request-x-forwarded-for"), "198.18.0.1");
    for (const name of ["cookie", "authorization", "x-blast-api-key", "x-blast-home-rewrite", "x-blast-profile-rewrite"]) {
      assert.equal(response.headers.get(`x-middleware-request-${name}`), null, name);
      assert.equal(forwarded?.includes(name), false, name);
    }
    noStore(response);
  }
  assert.equal(verify.mock.callCount(), 0);
  for (const [path, method, status] of [["/api/v1/presales", "POST", 405], ["/api/v1/presales/viewer", "GET", 403], ["/api/v2/presales", "GET", 403]] as const) {
    const input = new NextRequest(request(path, {}, method));
    assert.equal(isRegionalPartnerRead(input), false);
    assert.equal((await proxy(input)).status, status);
  }
  assert.equal((await proxy(new NextRequest(request("/api/social/presales")))).status, 403);
  assert.equal(verify.mock.callCount(), 0, "Unversioned aliases are rejected before key lookup");
  const priorBackendOrigin = process.env.BLAST_BACKEND_API_ORIGIN;
  delete process.env.BLAST_BACKEND_API_ORIGIN;
  t.after(() => {
    if (priorBackendOrigin === undefined) delete process.env.BLAST_BACKEND_API_ORIGIN;
    else process.env.BLAST_BACKEND_API_ORIGIN = priorBackendOrigin;
  });
  const application = await import("#web/app/api/v1/[...path]/route.ts");
  assert.equal(application.dynamic, "force-dynamic");
  assert.equal(application.OPTIONS, application.GET);
  for (const handler of [application.GET, application.HEAD]) {
    const response = await handler(new Request(URL_V1, { headers: { cookie: "team=present", "x-blast-partner-authorized": "1" } }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "partner_api_unavailable");
    noStore(response);
  }
  assert.equal(verify.mock.callCount(), 0, "The frontend never performs a second key lookup");
});

test("all unversioned read aliases reject partner keys and preflights before key lookup", async (context) => {
  const verify = context.mock.method(partnerKeyReader, "verify", async () => { throw new Error("Unexpected key lookup"); });
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("#web/proxy.ts");
  const { withGateCookie } = await import("../test/fixtures/lib/web-security/api-gate-fixtures.ts");
  const paths = [PATH, `${PATH}/featured`, `${PATH}/${ID}`, "/api/v1/prices", "/api/v1/discovery", "/api/v1/search",
    "/api/v1/market/status", `/api/v1/market/coins/${ID}%3A%3Acoin%3A%3ACOIN/holders`,
    `/api/v1/market/launches/${ID}/activity`, `/api/v1/market/pools/blast_curve/${ID}`,
    ...["cetus", "bluefin", "blast_curve"].map((venue) => `/api/v1/market/pools/${venue}/${ID}/candles`),
    ...["cetus", "bluefin"].map((venue) => `/api/v1/market/pools/${venue}/${ID}/trades`),
  ];
  const aliases = paths.map((path) => {
    const route = partnerV1Route(path);
    assert.ok(route, path);
    return route.sourcePath;
  });
  // DeFiLlama is versioned-only: it has no unversioned source route to alias.
  aliases.push(...["/api", "/api/social", "/api/launchpad"].flatMap((prefix) =>
    ["metadata", "metrics", "contracts"].map((operation) => `${prefix}/defillama/${operation}`)));
  for (const alias of aliases) {
    assert.equal(partnerV1Route(alias), null, alias);
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      const input = method === "OPTIONS" ? preflight(alias) : withGateCookie(request(alias, {}, method));
      const response = await proxy(new NextRequest(input));
      assert.equal(response.status, 403, `${method} ${alias}`);
      assert.equal(response.headers.get("x-middleware-next"), null);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
      if (method === "HEAD") assert.equal(await response.text(), "");
      else assert.equal((await response.json()).error.code, "partner_read_forbidden");
    }
  }
  assert.equal(verify.mock.callCount(), 0);
});

test("private frontend and write boundaries survive partner access, and v1 is forwarded even without a key", async (context) => {
  const previous = { ...process.env };
  context.after(() => { process.env = previous; });
  const verify = context.mock.method(partnerKeyReader, "verify", async () => { throw new Error("Unexpected key lookup"); });
  Object.assign(process.env, {
    BLAST_PRESALE_ENABLED: "team", BLAST_SOCIAL_ENABLED: "team", BLAST_TRADING_ENABLED: "team",
    BLAST_LAUNCHPAD_ENABLED: "false",
  });
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("#web/proxy.ts");
  const { withGateCookie } = await import("../test/fixtures/lib/web-security/api-gate-fixtures.ts");
  for (const path of [PATH, "/api/v1/prices", "/api/v1/market/status"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await proxy(new NextRequest(request(path, {}, method)));
      assert.equal(response.headers.get("x-middleware-next"), "1", path);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
    }
  }
  // The backend answers a keyless v1 read with 401; a gate cookie never stands in for a key.
  const missing = withGateCookie(new Request(URL_V1));
  assert.equal(isPartnerRequest(missing), true);
  const keyless = await proxy(new NextRequest(missing));
  assert.equal(keyless.headers.get("x-middleware-next"), "1");
  assert.equal(keyless.headers.get("x-middleware-request-cookie"), null);
  for (const path of ["/", "/create", "/api/social/me", "/api/social/feed", "/api/admin/partner-keys"]) {
    assert.equal((await proxy(new NextRequest(request(path)))).status, 403, path);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await proxy(new NextRequest(request(PATH, {}, method)))).status, 405);
  }
  const anonymous = new Request("https://www.blast.fun/api/social/presales", { headers: { "x-blast-partner-authorized": "1" } });
  // Launched: "team" is public, so the spoofed header just reaches the public route; it is never a partner read.
  assert.equal((await proxy(new NextRequest(withGateCookie(anonymous)))).headers.get("x-middleware-next"), "1");
  const home = await proxy(new NextRequest("https://www.blast.fun/"));
  assert.equal(home.headers.get("x-middleware-rewrite"), "https://www.blast.fun/feed");
  assert.equal(verify.mock.callCount(), 0);
});

test("the proxy keeps a partner's Origin for the backend and refuses unversioned partner reads before the public cache", async () => {
  const allow: RateLimitPort = { consume: async (bucket) => ({ allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 }) };
  let cacheReads = 0;
  const cached = { window: "24h", clock_ms: 1, prices: [], as_of: { checkpoint: 1, timestamp_ms: 1 } };
  const unexpected = () => { throw new Error("Public cached prices must not access accounts, sessions or the database"); };
  const kit = createSocialRouteKit({ expectedOrigin: "https://www.blast.fun", limiter: allow,
    verifyAccessToken: unexpected, accounts: { resolve: unexpected, resolveWallet: unexpected }, primary: unexpected,
    metricSampleRate: 0, tradingVisible: () => true,
  });
  const prices = createSocialPricesRoute({ kit, database: unexpected,
    publicRead: async <T>() => { cacheReads++; return cached as T; },
  });
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("#web/proxy.ts");
  const forwardedHeaders = (response: Response) => new Headers((response.headers.get("x-middleware-override-headers") ?? "").split(",")
    .filter(Boolean).map((name) => [name, response.headers.get(`x-middleware-request-${name}`)!]));
  const path = `/api/v1/prices?coin=0x${"0".repeat(63)}2::sui::SUI`;
  const delegated = await proxy(new NextRequest(request(path, { origin: ORIGIN })));
  assert.equal(forwardedHeaders(delegated).get("origin"), ORIGIN, "The proxy must preserve Origin until backend authorization");
  const legacyPath = path.replace("/api/v1/", "/api/social/");
  const refused = await proxy(new NextRequest(request(legacyPath, { origin: ORIGIN, "sec-fetch-site": "cross-site" })));
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "partner_read_forbidden");
  // The underlying site's own Origin guard stays strict when called directly.
  const untrustedDirectRead = await prices.GET(request(legacyPath, { origin: ORIGIN }), testClient());
  assert.equal(untrustedDirectRead.status, 403);
  assert.equal((await untrustedDirectRead.json()).error.code, "origin_invalid");
  assert.equal(cacheReads, 0, "Unversioned partner requests never reach the public cache");
});
