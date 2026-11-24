import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../../../core/test/fixtures/modules/database/testing.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";
import { SOCIAL_REWARDS_PATH, SOCIAL_REWARDS_ROUTE } from "@blast/core/modules/social/contracts/rewards.ts";

/**
 * OA-45: the production wiring. Rewards are read on the primary pool, never
 * the replica, and the production route answers a visitor 401, private and
 * no-store, before touching anything.
 */

// `server-only` is a bundler marker with no Node entry; outside Next it is empty.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const PRIMARY = "postgresql://app:app-secret@127.0.0.1:9/never_connected";
const REPLICA = "postgresql://reader:reader-secret@127.0.0.1:9/never_connected?application_name=replica";

function withEnvironment(t: TestContext, values: Record<string, string | undefined>): void {
  installRuntimeConfig(values);
  t.after(endProcessPools);
}

test("OA-45: rewards are read on the primary pool, never the replica, and only through what the route is given", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  assert.notEqual(primaryPool(), replicaPool());
  const runtime = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/rewards/runtime.ts")), "utf8");
  assert.match(runtime, /autocommitReader\(primaryPool\(\), "social"/);
  assert.match(runtime, /database: socialRewardsDatabase/);
  assert.match(runtime, /wallets: socialAccounts\(\)/);
  assert.doesNotMatch(runtime, /replicaPool|"replica"|databaseFor\(/);
  for (const file of ["@blast/server/modules/social/rewards/route.ts", "@blast/server/modules/social/rewards/read.ts"]) {
    const code = await readFile(new URL(import.meta.resolve(file)), "utf8");
    assert.doesNotMatch(code, /databaseFor|Pool\b/, file);
  }
  const handler = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/rewards/route.ts")), "utf8");
  assert.match(handler, /auth: "account", account: "required", bucket: "social_read", cache: "private"/);
  assert.match(handler, /wallets\.wallets\(context\.account!\.account_id\)/);
  assert.equal(SOCIAL_REWARDS_ROUTE, `GET ${SOCIAL_REWARDS_PATH}`);
});

test("OA-45: the production route without a token is 401, private and no-store, with no reward field", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const { socialRewardsRoute } = await import("@blast/server/modules/social/rewards/runtime.ts");
  const { GET } = socialRewardsRoute();
  for (const headers of [{}, { authorization: "Bearer" }, { authorization: "Token abc" }] as Record<string, string>[]) {
    const response = await GET(new Request("https://blast.fun/api/social/me/rewards", { headers }), testClient());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(response.headers.get("x-request-id"));
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal((body.error as { code: string }).code, "unauthorized");
  }
});
