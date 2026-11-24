import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../../../core/test/fixtures/modules/database/testing.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";
import { SOCIAL_TRANSACTIONS_PATH, SOCIAL_TRANSACTIONS_ROUTE } from "@blast/core/modules/social/contracts/transactions.ts";

/**
 * Social feed R3-27-AC-5: the production wiring. The log is read on the
 * primary pool, never the replica, and the production route answers a
 * visitor 401, private and no-store, before touching anything.
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

test("R3-27-AC-5: the log is read on the primary pool, never the replica, and only through what the route is given", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  assert.notEqual(primaryPool(), replicaPool());
  const runtime = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/transactions/runtime.ts")), "utf8");
  assert.match(runtime, /autocommitReader\(primaryPool\(\), "social"/);
  assert.match(runtime, /database: socialTransactionsDatabase/);
  assert.doesNotMatch(runtime, /replicaPool|"replica"|databaseFor\(/);
  for (const file of ["@blast/server/modules/social/transactions/route.ts", "@blast/server/modules/social/transactions/read.ts", "@blast/core/modules/social/transactions/log.ts"]) {
    const code = await readFile(new URL(import.meta.resolve(file)), "utf8");
    assert.doesNotMatch(code, /databaseFor|Pool\b/, file);
  }
  const handler = await readFile(new URL(import.meta.resolve("@blast/server/modules/social/transactions/route.ts")), "utf8");
  assert.match(handler, /auth: "account", account: "required", bucket: "social_read", cache: "private"/);
  assert.match(handler, /context\.account!\.account_id/);
  assert.equal(SOCIAL_TRANSACTIONS_ROUTE, `GET ${SOCIAL_TRANSACTIONS_PATH}`);
});

test("R3-27-AC-5: the production route without a token is 401, private and no-store, with no transaction field", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  const { socialTransactionsRoute } = await import("@blast/server/modules/social/transactions/runtime.ts");
  const { GET } = socialTransactionsRoute();
  for (const headers of [{}, { authorization: "Bearer" }, { authorization: "Token abc" }] as Record<string, string>[]) {
    const response = await GET(new Request("https://blast.fun/api/social/me/transactions", { headers }), testClient());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(response.headers.get("x-request-id"));
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal((body.error as { code: string }).code, "unauthorized");
  }
});
