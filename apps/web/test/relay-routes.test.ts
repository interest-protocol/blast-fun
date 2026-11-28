import assert from "node:assert/strict";
import test from "node:test";
import { verifyPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { createPrivateApiCatchAll } from "#web/lib/backend-api/private-api-catch-all.ts";
import { relayDrift } from "#web/scripts/generate-relay-routes.ts";
import { GET, HEAD, OPTIONS, PUT, maxDuration } from "../src/app/api/[...path]/route.ts";

const siteOrigin = "http://127.0.0.1:3000";

test("every relay route file is exactly what the route tables generate", () => {
  assert.deepEqual(relayDrift(), []);
});

test("catch-all preserves path priority and Next's method responses without forwarding refusals", async () => {
  const keys = siteOrigin + "/api/social/me/watchlist/keys";
  const item = siteOrigin + "/api/social/me/watchlist/123";
  const unsupported = await PUT(new Request(keys, { method: "PUT" }));
  assert.equal(unsupported.status, 405);
  assert.equal(await unsupported.text(), "");

  const keysOptions = await OPTIONS(new Request(keys, { method: "OPTIONS" }));
  assert.equal(keysOptions.status, 204);
  assert.equal(keysOptions.headers.get("Allow"), "GET, HEAD, OPTIONS");
  const itemOptions = await OPTIONS(new Request(item, { method: "OPTIONS" }));
  assert.equal(itemOptions.status, 204);
  assert.equal(itemOptions.headers.get("Allow"), "DELETE, OPTIONS, PUT");

  assert.equal((await GET(new Request(siteOrigin + "/api/social/launch-context"))).status, 404);
  assert.equal((await GET(new Request(siteOrigin + "/api/social/me/creator-earnings"))).status, 404);

  const getOnly = createPrivateApiCatchAll([["/api/get-only", ["GET"]]]);
  const automaticHead = await getOnly(new Request(siteOrigin + "/api/get-only", { method: "OPTIONS" }));
  assert.equal(automaticHead.headers.get("Allow"), "GET, HEAD, OPTIONS");
});

test("catch-all keeps the browser proof, body limit and relay timeout on the signed path", async (t) => {
  const secret = "synthetic-private-gateway-secret-0123456789";
  const environment = {
    BLAST_BACKEND_API_ORIGIN: "https://backend.test",
    BLAST_BACKEND_GATEWAY_SECRET: secret,
    BLAST_DEPLOYMENT_TARGET: "local",
    BLAST_REDIS_NAMESPACE: "private-relay-fixture",
    NEXT_PUBLIC_SITE_URL: siteOrigin,
  };
  const { quotaNamespace: namespace } = parseRelayConfig(environment);
  assert.ok(namespace);
  for (const [name, value] of Object.entries(environment)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
  }

  const timeout = t.mock.method(AbortSignal, "timeout");
  const cookie = "__Host-blast_wallet=synthetic-session";
  const fetch = t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://backend.test/api/account/settings?fixture=1");
    assert.equal(request.method, "HEAD");
    assert.equal(request.headers.get("cookie"), cookie);
    assert.equal(request.headers.get("x-forwarded-for"), null);
    const proof = verifyPrivateRequest(request, new Uint8Array(), secret, { namespace, siteOrigin });
    assert.equal(proof?.route.id, "account.settings.read");
    assert.equal(proof?.purpose, "browser");
    assert.equal(proof?.ip, "127.0.0.1");
    return new Response(null, { status: 200 });
  });

  const url = siteOrigin + "/api/account/settings";
  assert.equal(maxDuration, 40);
  const response = await HEAD(new Request(url + "?fixture=1", {
    method: "HEAD",
    headers: { cookie, "x-forwarded-for": "192.0.2.1" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(timeout.mock.calls.map(({ arguments: args }) => args), [[35_000]]);

  const oversized = await PUT(new Request(url, {
    method: "PUT",
    headers: { "content-length": "65537" },
  }));
  assert.equal(oversized.status, 413);
  const partner = await GET(new Request(url, { headers: { "x-blast-partner-key": "synthetic" } }));
  assert.equal(partner.status, 403);
  assert.equal(fetch.mock.callCount(), 1);
});
