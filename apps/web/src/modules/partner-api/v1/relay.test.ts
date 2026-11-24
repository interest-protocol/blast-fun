import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { verifyGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  return next(specifier, context);
} });

const routes: ReadonlyArray<readonly [string, string, string]> = [
  ["social/prices", "../../../app/api/social/prices/route.ts", "prices"],
  ["social/presales", "../../../app/api/social/presales/route.ts", "presales"],
  ["social/presales/featured", "../../../app/api/social/presales/featured/route.ts", "presales/featured"],
  [`social/presales/0x${"a".repeat(64)}`, "../../../app/api/social/presales/[presale_id]/route.ts", `presales/0x${"a".repeat(64)}`],
  ["launchpad/discovery", "../../../app/api/launchpad/discovery/route.ts", "discovery"],
  ["launchpad/search", "../../../app/api/launchpad/search/route.ts", "search"],
  [`launchpad/wallets/0x${"a".repeat(64)}/launches`, "../../../app/api/launchpad/wallets/[address]/launches/route.ts", `wallets/0x${"a".repeat(64)}/launches`],
  ["launchpad/market/status", "../../../app/api/launchpad/market/status/route.ts", "market/status"],
  ["launchpad/market/creator-claims", "../../../app/api/launchpad/market/creator-claims/route.ts", "market/creator-claims"],
  ...["cetus", "bluefin"].map((venue) => [`launchpad/market/pools/${venue}/0x${"a".repeat(64)}`, "../../../app/api/launchpad/market/pools/[venue]/[poolId]/route.ts", `market/pools/${venue}/0x${"a".repeat(64)}`] as const),
];
const secret = "synthetic-read-proof-secret-only".repeat(2);

test("frontend-only reads stay private while shared pool summaries keep their canonical paths", async () => {
  const { firstPartyCanonicalPath } = await import("./relay.ts");
  const { partnerV1Route } = await import("@blast/server/modules/partner-api/v1/paths.ts");
  const id = "0x" + "a".repeat(64);
  for (const suffix of ["creator-claims"]) {
    const canonical = "/api/v1/market/" + suffix;
    assert.equal(firstPartyCanonicalPath("/api/launchpad/market/" + suffix), canonical);
    assert.equal(partnerV1Route(canonical), null);
  }
  const holderPath = `/api/launchpad/market/wallets/${id}/vault-rewards`;
  assert.equal(firstPartyCanonicalPath(holderPath), `/api/v1/market/wallets/${id}/launch-holder-rewards`);
  assert.equal(partnerV1Route(`/api/v1/market/wallets/${id}/vault-rewards`), null);
  for (const venue of ["blast_curve", "cetus", "bluefin"]) {
    const sourcePath = `/api/launchpad/market/pools/${venue}/${id}`;
    const canonical = `/api/v1/market/pools/${venue}/${id}`;
    assert.equal(firstPartyCanonicalPath(sourcePath), canonical);
    assert.deepEqual(partnerV1Route(canonical), { name: "market", sourcePath });
  }
  for (const path of [
    "/api/launchpad/wallets/me/launches",
    `/api/launchpad/wallets/${id}/launches/private`,
    "/api/launchpad/market/creator-claims/private",
    `/api/launchpad/market/pools/unknown/${id}`,
    `/api/launchpad/market/pools/cetus/${id}/private`,
    "/api/launchpad/market/pools/cetus/0xa",
  ]) assert.equal(firstPartyCanonicalPath(path), null, path);
});

function configure(t: TestContext, configured: boolean) {
  const previous = { ...process.env };
  takeProcessSingleton("relayConfig");
  t.after(() => {
    process.env = previous;
    takeProcessSingleton("relayConfig");
  });
  process.env.VERCEL = "1";
  process.env.NEXT_PUBLIC_SITE_URL = "https://frontend.invalid";
  process.env.BLAST_REDIS_NAMESPACE = "mainnet:test:production";
  process.env.VERCEL_ENV = "production";
  process.env.VERCEL_TARGET_ENV = "production";
  delete process.env.BLAST_BACKEND_API_ORIGIN;
  delete process.env.BLAST_BACKEND_GATEWAY_SECRET;
  if (configured) {
    process.env.BLAST_BACKEND_API_ORIGIN = "https://backend.invalid";
    process.env.BLAST_BACKEND_GATEWAY_SECRET = secret;
  }
}

async function handler(path: string): Promise<(request: Request) => Promise<Response>> {
  return (await import(new URL(path, import.meta.url).href)).GET;
}

test("all selected frontend public routes refuse missing backend configuration without opening local stores", async (t) => {
  configure(t, false);
  let connections = 0;
  let forwarded = 0;
  t.mock.method(Socket.prototype, "connect", () => {
    connections++;
    throw new Error("No local database or network fallback is allowed");
  });
  t.mock.method(globalThis, "fetch", async () => {
    forwarded++;
    throw new Error("Unconfigured routes cannot select an upstream");
  });
  for (const [path, modulePath] of routes) {
    const response = await (await handler(modulePath))(new Request(`https://frontend.invalid/api/${path}`));
    assert.equal(response.status, 503, path);
    const body = await response.json();
    assert.equal(body.error.code, path.includes("market/") ? "unavailable" : path.startsWith("launchpad/") ? "LAUNCHPAD_READ_UNAVAILABLE" : "service_unavailable", path);
    assert.equal(response.headers.get("retry-after"), "5");
  }
  const { partnerV1Read } = await import("./runtime.ts");
  const refused = await partnerV1Read(new Request("https://frontend.invalid/api/v1/prices"));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.code, "partner_api_unavailable");
  assert.equal(connections, 0);
  assert.equal(forwarded, 0);
});

test("selected frontend public routes always use the signed backend without forwarding user credentials", async (t) => {
  configure(t, true);
  const forwarded: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push(new Request(input, init));
    return Response.json({ source: "backend" });
  });
  for (const [path, modulePath, canonical] of routes) {
    const response = await (await handler(modulePath))(new Request(`https://frontend.invalid/api/${path}?limit=3`, {
      headers: { cookie: "__Host-blast_wallet=existing-synthetic-session", authorization: "Bearer existing-synthetic-token", "x-vercel-forwarded-for": "198.18.0.1", "x-forwarded-for": "203.0.113.99" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source: "backend" });
    const request = forwarded.at(-1)!;
    assert.equal(request.url, `https://backend.invalid/internal/public-read/api/v1/${canonical}?limit=3`);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(verifyGatewayRequest(request, secret, quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)))?.ip, "198.18.0.1");
  }
  assert.equal(forwarded.length, routes.length, "Each frontend read forwards exactly once");
});

test("only DeFiLlama reporting routes allow anonymous versioned reads", async (t) => {
  configure(t, true);
  const { partnerV1Read } = await import("./runtime.ts");
  const forwarded: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    forwarded.push(request);
    return request.method === "HEAD" ? new Response(null) : Response.json({ source: "backend" });
  });
  const headers = {
    "x-vercel-forwarded-for": "198.18.0.1",
    origin: "https://dashboard.invalid",
    cookie: "synthetic=secret",
  };
  for (const [method, suffix] of [
    ["GET", "metadata"],
    ["GET", "metrics?date=2026-11-07&cursor=opaque%2Bcursor"],
    ["GET", "fees?date=2026-11-07"],
    ["HEAD", "contracts?timestamp=1794096000"],
  ]) {
    const path = "/api/v1/defillama/" + suffix;
    const response = await partnerV1Read(new Request("https://frontend.invalid" + path, { method, headers }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-blast-api-version"), "1");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    if (method === "HEAD") assert.equal(response.body, null);
    const request = forwarded.at(-1)!;
    assert.equal(request.url, "https://backend.invalid/internal/public-read" + path);
    assert.equal(request.method, method);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.headers.get("x-blast-partner-key"), null);
    assert.equal(verifyGatewayRequest(request, secret, quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)))?.ip, "198.18.0.1");
  }

  const reportingUrl = "https://frontend.invalid/api/v1/defillama/metrics";
  const preflight = await partnerV1Read(new Request(reportingUrl, { method: "OPTIONS", headers }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  const unknown = await partnerV1Read(new Request(reportingUrl + "/private", { headers }));
  assert.equal(unknown.status, 404);
  assert.equal(forwarded.length, 4);

  await partnerV1Read(new Request(reportingUrl, { headers: { ...headers, "x-blast-partner-key": "synthetic-key" } }));
  assert.equal(forwarded.at(-1)!.url, "https://backend.invalid/api/v1/defillama/metrics");
  assert.equal(forwarded.at(-1)!.headers.get("x-blast-partner-key"), "synthetic-key");
  await partnerV1Read(new Request("https://frontend.invalid/api/v1/prices", { headers }));
  assert.equal(forwarded.at(-1)!.url, "https://backend.invalid/api/v1/prices");
});
