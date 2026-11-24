import assert from "node:assert/strict";
import test from "node:test";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";

test("draft capabilities retain reviewed method, body and lifetime boundaries without SSR grants", () => {
  const base = "/api/social/me/drafts/11111111-1111-4111-8111-111111111111";
  for (const [method, path, id, bytes, budget] of [
    ["GET", "/api/social/me/drafts", "social.create.list", 0, 30_000],
    ["GET", base, "social.create.read", 0, 30_000],
    ["PUT", base, "social.create.save", 65_536, 60_000],
    ["DELETE", base, "social.create.delete", 0, 30_000],
    ["PUT", base + "/logo", "social.create.logo", 2_097_152, 90_000],
    ["POST", base + "/cover", "social.create.cover.upload", 4_016_384, 90_000],
    ["DELETE", base + "/cover", "social.create.cover.delete", 0, 60_000],
    ["POST", base + "/published", "social.create.published", 1024, 60_000],
    ["POST", base + "/publish", "social.create.publish", 4096, 120_000],
  ] as const) {
    const route = privateRoute(method, path, "browser");
    assert.equal(route?.id, id);
    assert.equal(route.maxBodyBytes, bytes);
    assert.equal(route.workBudgetMs ?? 30_000, budget);
    assert.equal(privateRoute(method, path, "ssr-read"), null);
    assert.equal(privateRoute("PATCH", path, "browser"), null);
    if (method === "GET") {
      assert.equal(privateRoute("HEAD", path, "browser")?.id, id);
    }
    const request = new Request("https://frontend.test" + path, { method });
    const options = {
      namespace: "c".repeat(64),
      purpose: "browser" as const,
      siteOrigin: "https://frontend.test",
      ip: "192.0.2.1",
    };
    assert.doesNotThrow(() =>
      signPrivateRequest(
        request,
        new Uint8Array(bytes),
        "synthetic-create-proof-secret-0123456789",
        options,
      ),
    );
    assert.throws(() =>
      signPrivateRequest(
        request,
        new Uint8Array(bytes + 1),
        "synthetic-create-proof-secret-0123456789",
        options,
      ),
    );
  }
});

test("create context is exclusively one zero-body SSR GET capability", () => {
  const path = "/api/social/create-context";
  assert.equal(privateRoute("GET", path, "ssr-read")?.id, "social.create.context");
  assert.equal(privateRoute("GET", path, "ssr-read")?.maxBodyBytes, 0);
  assert.equal(privateRoute("GET", path, "browser"), null);
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
    assert.equal(privateRoute(method, path, "ssr-read"), null);
  }
});
