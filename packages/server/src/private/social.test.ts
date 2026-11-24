import assert from "node:assert/strict";
import test from "node:test";
import { SOCIAL_PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private/social-contracts.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { siteOrigin } from "../lib/site-origin.ts";
import { installRuntimeConfig } from "../../test/fixtures/config/runtime-config.ts";
import { privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";
import type { PrivateContext } from "./handler.ts";

installRuntimeConfig();
const site = siteOrigin();

function context(route: VerifiedPrivateProof["route"]): PrivateContext {
  return { proof: { route, purpose: "browser", namespace: "social-test", siteOrigin: site, ip: "127.0.0.1", issued: "1", bodySha256: "0".repeat(64), nonce: "test" }, client: testClient() };
}

function path(route: VerifiedPrivateProof["route"]): string {
  return route.path.replaceAll(/:\w+/g, "target");
}

test("every social dispatch keeps business authentication after a verified transport proof, including HEAD", async () => {
  for (const route of SOCIAL_PRIVATE_ROUTES) {
    const request = new Request(site + path(route), { method: route.method });
    const response = await privateApi(request, context(route));
    assert.equal(response.status, 401, `${route.method} ${route.id}`);
    assert.equal((await response.json()).error.code, "unauthorized", route.id);
  }
});

test("transport authority does not bypass original Origin checks or grant SSR to account data", async () => {
  for (const route of SOCIAL_PRIVATE_ROUTES) {
    assert.notEqual(route.ssrRead, true, route.id);
    const response = await privateApi(new Request(site + path(route), {
      method: route.method, headers: { origin: "https://other.invalid" },
    }), context(route));
    assert.equal(response.status, 403, route.id);
    assert.equal((await response.json()).error.code, "origin_invalid", route.id);
  }
});
