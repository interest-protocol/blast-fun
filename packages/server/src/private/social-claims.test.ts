import assert from "node:assert/strict";
import test from "node:test";
import { SOCIAL_CLAIMS_PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private/social-claims-contracts.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { siteOrigin } from "../lib/site-origin.ts";
import { installRuntimeConfig } from "../../test/fixtures/config/runtime-config.ts";
import { privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";

installRuntimeConfig();
const site = siteOrigin();

test("claims transport preserves original caller and Origin authority", async () => {
  for (const route of SOCIAL_CLAIMS_PRIVATE_ROUTES) {
    const proof: VerifiedPrivateProof = { route, namespace: "coins", purpose: "browser", siteOrigin: site, ip: "127.0.0.1", issued: "1", bodySha256: "0".repeat(64), nonce: "test" };
    const paths: Readonly<Record<string, string>> = {
      "social.me.creator-earnings": "/api/social/me/creator-earnings",
      "social.me.creator-commitment": "/api/social/me/creator-commitment",
      "social.me.creator-caps": "/api/social/me/creator-caps",
      "social.me.launch-claims": "/api/social/me/launch-claims/id",
    };
    const path = paths[route.id] ?? "/api/social/me/claims/id";
    for (const foreign of [false, true]) {
      const response = await privateApi(new Request(site + path, { method: route.method, ...(foreign ? { headers: { origin: "https://foreign.invalid" } } : {}) }), { proof, client: testClient() });
      assert.equal(response.status, foreign ? 403 : 401);
    }
  }
});
