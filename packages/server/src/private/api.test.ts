import assert from "node:assert/strict";
import test from "node:test";
import { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { PRIVATE_HANDLER_FAMILIES, PRIVATE_HANDLERS, privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";
import { withErrorBoundary, type PrivateContext } from "./handler.ts";

function context(id: string): PrivateContext {
  const proof: VerifiedPrivateProof = {
    route: { id, method: "GET", path: "/", maxBodyBytes: 0 }, purpose: "browser",
    namespace: "api-test", siteOrigin: "https://www.blast.fun", ip: "127.0.0.1",
    issued: "1", nonce: "test", bodySha256: "0".repeat(64),
  };
  return { proof, client: testClient() };
}

// This fails if a contract loses its handler, a handler outlives its contract,
// or two families claim one id (the merge would silently keep only one).
test("every main-API route id has exactly one handler and no handler lacks a route", () => {
  const routeIds = new Set(PRIVATE_ROUTES.map((route) => route.id));
  const handlerIds = Object.keys(PRIVATE_HANDLERS);

  assert.deepEqual([...handlerIds].sort(), [...routeIds].sort());
  assert.equal(PRIVATE_HANDLER_FAMILIES.reduce((sum, family) => sum + Object.keys(family).length, 0), handlerIds.length);
});

// This fails if an unknown or object-prototype id reaches a handler instead of 404.
test("unknown and object-prototype route ids answer 404", async () => {
  for (const id of ["social.unknown", "__proto__", "constructor", "toString"]) {
    const response = await privateApi(new Request("https://www.blast.fun/"), context(id));
    assert.equal(response.status, 404, id);
    assert.equal((await response.json()).error.code, "not_found", id);
  }
});

// This fails if a thrown owner escapes the boundary or leaks its message.
test("a throwing handler answers a retryable 503 without its message", async () => {
  const handler = withErrorBoundary(async () => {
    throw new Error("private database diagnostic");
  });
  const response = await handler(new Request("https://www.blast.fun/"), context("social.me"));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: { code: "service_unavailable", message: "This service is temporarily unavailable. Please retry." },
  });
});
