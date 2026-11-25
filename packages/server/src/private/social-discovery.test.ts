import assert from "node:assert/strict";
import test from "node:test";
import { routePattern } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_DISCOVERY_PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private/social-discovery-contracts.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { siteOrigin } from "../lib/site-origin.ts";
import { installRuntimeConfig } from "../../test/fixtures/config/runtime-config.ts";
import { privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";

installRuntimeConfig();
const site = siteOrigin();

test("discovery keeps original Origin checks before public SQL, including HEAD", async () => {
  for (const route of SOCIAL_DISCOVERY_PRIVATE_ROUTES) {
    const proof: VerifiedPrivateProof = { route, namespace: "discovery", purpose: "browser", siteOrigin: site, ip: "127.0.0.1", issued: "1", bodySha256: "0".repeat(64), nonce: "test" };
    const path = route.path;
    const response = await privateApi(new Request(site + path, { method: route.method, headers: { origin: "https://foreign.invalid" } }), { proof, client: testClient() });
    assert.equal(response.status, 403, route.id);
  }
});

test("only actual happening page reads carry SSR capability, never hint streams", () => {
  // Activity, its followed buy card, happening and search: each a GET with its HEAD.
  assert.equal(SOCIAL_DISCOVERY_PRIVATE_ROUTES.length, 8);
  assert.deepEqual(SOCIAL_DISCOVERY_PRIVATE_ROUTES.filter((route) => route.ssrRead).map((route) => [route.id, route.method]), [["social.happening", "GET"], ["social.happening", "HEAD"]]);
  assert.ok(SOCIAL_DISCOVERY_PRIVATE_ROUTES.every((route) => route.maxBodyBytes === 0 && !routePattern(route.path).test("/api/social/activity/hints")));
});
