import assert from "node:assert/strict";
import test from "node:test";
import { SOCIAL_READ_PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private/social-read-contracts.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { siteOrigin } from "../lib/site-origin.ts";
import { installRuntimeConfig } from "../../test/fixtures/config/runtime-config.ts";
import { privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";
import type { PrivateContext } from "./handler.ts";

installRuntimeConfig();
const site = siteOrigin();

function context(route: VerifiedPrivateProof["route"]): PrivateContext {
  return { proof: { route, namespace: "read-test", purpose: "browser", siteOrigin: site, ip: "127.0.0.1", issued: "1", bodySha256: "0".repeat(64), nonce: "test" }, client: testClient() };
}
function request(route: VerifiedPrivateProof["route"], foreignOrigin = false): Request {
  const path = route.path.replaceAll(/:\w+/g, "target");
  return new Request(site + path, { method: route.method, ...(foreignOrigin ? { headers: { origin: "https://foreign.invalid" } } : {}) });
}

test("all27 read/comment dispatch variants retain original Origin checks before database work", async () => {
  for (const route of SOCIAL_READ_PRIVATE_ROUTES) {
    const response = await privateApi(request(route, true), context(route));
    assert.equal(response.status, 403, route.id);
    assert.equal((await response.json()).error.code, "origin_invalid", route.id);
  }
});

test("comment mutations and private profile reads still require caller authority", async () => {
  const privateIds = new Set(["social.reaction.put", "social.reaction.delete", "social.why.create", "social.why.delete", "social.why.report", "social.profile.mutuals", "social.me.presales", "social.me.presales.created"]);
  for (const route of SOCIAL_READ_PRIVATE_ROUTES.filter((route) => privateIds.has(route.id))) {
    const response = await privateApi(request(route), context(route));
    assert.equal(response.status, 401, route.id);
  }
});

test("SSR capability is limited to the four actual page read paths and never comments/viewer APIs", () => {
  const reads = SOCIAL_READ_PRIVATE_ROUTES.filter((route) => route.ssrRead);
  assert.equal(reads.length, 8);
  assert.deepEqual([...new Set(reads.map((route) => route.id))].sort(), ["social.feed", "social.post", "social.profile", "social.profile.calls"]);
  assert.ok(reads.every((route) => route.method === "GET" || route.method === "HEAD"));
});
