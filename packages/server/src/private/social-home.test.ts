import assert from "node:assert/strict";
import test from "node:test";
import { SOCIAL_HOME_PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private/social-home-contracts.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { siteOrigin } from "../lib/site-origin.ts";
import { installRuntimeConfig } from "../../test/fixtures/config/runtime-config.ts";
import { privateApi } from "./api.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";
import type { PrivateContext } from "./handler.ts";

installRuntimeConfig();
const site = siteOrigin();

function context(route: VerifiedPrivateProof["route"]): PrivateContext {
  return { proof: { route, namespace: "home", purpose: "browser", siteOrigin: site, ip: "127.0.0.1", issued: "1", bodySha256: "0".repeat(64), nonce: "test" }, client: testClient() };
}
function request(route: VerifiedPrivateProof["route"], foreign: boolean): Request {
  const path = route.path.replaceAll(/:\w+/g, "target");
  return new Request(site + path, { method: route.method, ...(foreign ? { headers: { origin: "https://foreign.invalid" } } : {}) });
}
test("home and portfolio closed routes keep Origin refusal before SQL", async () => {
  for (const route of SOCIAL_HOME_PRIVATE_ROUTES) assert.equal((await privateApi(request(route, true), context(route))).status, 403, route.id);
});
test("owner portfolio and following never gain caller authority from transport", async () => {
  const ids = new Set(["social.home.following", "social.home.my_trades", "social.portfolio", "social.portfolio.coins", "social.portfolio.history", "social.pnl"]);
  for (const route of SOCIAL_HOME_PRIVATE_ROUTES.filter((route) => ids.has(route.id))) assert.equal((await privateApi(request(route, false), context(route))).status, 401, route.id);
});
test("SSR capability covers exactly the three actual public home page reads", () => {
  const routes = SOCIAL_HOME_PRIVATE_ROUTES.filter((route) => route.ssrRead);
  assert.equal(routes.length, 6);
  assert.deepEqual([...new Set(routes.map((route) => route.id))].sort(), ["social.home", "social.home.coins", "social.home.traders"]);
});
