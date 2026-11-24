import assert from "node:assert/strict";
import test from "node:test";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { createBackendHttp } from "../src/app/server.ts";

const origin = "https://frontend.test";
const secret = "synthetic-viewer-theses-transport-secret-0123456789";
const namespace = "a".repeat(64);
const rows = [
  ["POST", "/api/social/presales/viewer", "social.presales.viewer", 4096],
  ["GET", "/api/launchpad/theses", "launchpad.theses.read", 0],
  ["HEAD", "/api/launchpad/theses", "launchpad.theses.read", 0],
  ["POST", "/api/launchpad/theses", "launchpad.theses.write", 16384],
] as const;

test("viewer and thesis methods retain exact bodies, ordinary deadlines and no SSR capability", () => {
  for (const [method, path, id, limit] of rows) {
    const route = privateRoute(method, path, "browser");
    assert.equal(route?.id, id);
    assert.equal(route.maxBodyBytes, limit);
    assert.equal(route.workBudgetMs, 30_000);
    assert.equal(privateRoute(method, path, "ssr-read"), null);
  }
  for (const path of ["/api/social/presales/viewer", "/api/launchpad/theses"]) {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal(privateRoute(method, path, "browser"), null);
    }
  }
});

test("signed viewer/theses envelopes reject unproved/oversize work before owner dispatch", async () => {
  let calls = 0;
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      handle: async () => {
        calls++;
        return new Response("ok");
      },
    },
  });
  for (const [method, path, , limit] of rows.filter(([method]) => method === "POST")) {
    const denied = await runtime.fetch(
      new Request(origin + path, { method, body: "{}" }),
      "127.0.0.1",
    );
    assert.equal(denied.status, 403);
    await denied.arrayBuffer();
    for (const size of [limit, limit + 1]) {
      const bytes = new Uint8Array(size);
      const source = new Request(origin + path, {
        method,
        body: bytes.slice().buffer,
      });
      const headers = signPrivateRequest(source, bytes.subarray(0, limit), secret, {
        namespace,
        purpose: "browser",
        siteOrigin: origin,
        ip: "192.0.2.1",
      });
      const response = await runtime.fetch(
        new Request(source.url, {
          method,
          headers,
          body: bytes.slice().buffer,
        }),
        "127.0.0.1",
      );
      assert.equal(response.status, size === limit ? 200 : 413);
      await response.arrayBuffer();
    }
  }
  assert.equal(calls, 2);
});
