import assert from "node:assert/strict";
import test from "node:test";
import { SOCIAL_INTENTS_PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private/social-intents-contracts.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { siteOrigin } from "../lib/site-origin.ts";
import { installRuntimeConfig } from "../../test/fixtures/config/runtime-config.ts";
import { privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";

installRuntimeConfig();
const site = siteOrigin();

test("intent registration retain caller and Origin authority, never SSR", async () => {
  for (const route of SOCIAL_INTENTS_PRIVATE_ROUTES) {
    assert.equal(route.ssrRead, undefined);
    const proof: VerifiedPrivateProof = { route, namespace: "personal", purpose: "browser", siteOrigin: site, ip: "127.0.0.1", issued: "1", bodySha256: "0".repeat(64), nonce: "test" };
    const path = route.path;
    for (const foreign of [false, true]) {
      const response = await privateApi(new Request(site + path, { method: route.method, ...(foreign ? { headers: { origin: "https://foreign.invalid" } } : {}) }), { proof, client: testClient() });
      assert.equal(response.status, foreign ? 403 : 401, route.id);
    }
  }
});
