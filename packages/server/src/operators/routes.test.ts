import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_ROUTES } from "@blast/core/modules/backend-api/operator-routes.ts";
import { createOperatorRoutes } from "@blast/server/operators/routes.ts";

const handler = (id: string) => async () => Response.json({ id });
const route = createOperatorRoutes({
  "partner-keys": handler("partner-keys"),
  presales: handler("presales"),
  "bonding-feature": handler("bonding-feature"),
  "verified-mark": handler("verified-mark"),
  feedback: handler("feedback"),
  "reward-coins": handler("reward-coins"),
  "reward-blacklist": handler("reward-blacklist"),
  "gas-pool-health": handler("gas-pool-health"),
  "login-admission": handler("login-admission"),
});
const request = (path: string) => new Request(`https://backend.blast.test${path}`);

test("each operator row dispatches to its own owner and every other path falls through", async () => {
  for (const row of OPERATOR_ROUTES) {
    const path = row.path.replace(":coin_type", "0xabc%3A%3Acoin%3A%3ACOIN");
    assert.deepEqual(await (await route(request(path)))?.json(), { id: row.id });
  }
  for (const path of ["/api/admin", "/api/admin/unknown", "/api/admin/presales/", "/api/admin/coins//reward-blacklist", "/api/health", "/v1/admin/partner-keys"])
    assert.equal(await route(request(path)), null, path);
});
