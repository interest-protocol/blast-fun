import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { endProcessPools } from "../../../../../core/test/fixtures/modules/database/testing.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";
import { SOCIAL_COMMIT_ROUTE, SOCIAL_COMMITS_PATH } from "@blast/core/modules/social/contracts/commit.ts";

/**
 * The server-built commit's production wiring: the route reads the presale
 * deployment through the server's gate (mainnet only) and its node, resolves
 * the Blast wallet as the claim does, counts in its own `social_commit`
 * bucket, and a visitor is refused before anything is read.
 */

const PRIMARY = "postgresql://app:app-secret@127.0.0.1:9/never_connected";

function withEnvironment(t: TestContext, values: Record<string, string | undefined>): void {
  installRuntimeConfig(values);
  t.after(endProcessPools);
}

test("the production commit route reads the deployment on the server, mainnet only, and builds through the deployment's node", async () => {
  const runtime = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /import "server-only"/);
  assert.match(runtime, /fetch: boundedFetch\(8_000\)/);
  assert.match(runtime, /if \(mainnetIdentity\(gate\.state\) === null\) return null;\s*return presaleSigningIdentity\(gate, \{ signal, presalePauseBit: PRESALE_PAUSE_BITS\.Commit \}\);/);
  assert.match(runtime, /new SuiGrpcClient/);
  assert.match(runtime, /blastWallet: blastWalletOf/);
  const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(route, /auth: "account", account: "required", bucket: "social_commit", cache: "private"/);
  // The sale's types come from the chain, never from the client; the build is the SDK's (`commitTransaction`).
  assert.match(route, /saleToken: presale\.saleToken,\s*quoteType,/);
  assert.match(route, /const kind = await reads\.kind\(transaction, sender\);/);
  assert.doesNotMatch(route, /\.write\(|logTransaction|INSERT/, "a build writes nothing; the registration logs the commit");
  assert.equal(SOCIAL_COMMIT_ROUTE, `POST ${SOCIAL_COMMITS_PATH}`);
});

test("the production commit route without a token is 401, private and no-store, with nothing else in the body", async (t) => {
  withEnvironment(t, { DATABASE_URL: PRIMARY, PRESALE_DEPLOYMENT_MANIFEST: undefined });
  const { socialCommitRoutes } = await import("./runtime.ts");
  const POST = socialCommitRoutes().build;
  for (const headers of [{}, { authorization: "Bearer" }, { authorization: "Token abc" }] as Record<string, string>[]) {
    const response = await POST(new Request(`https://blast.fun${SOCIAL_COMMITS_PATH}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ presale_id: `0x${"ab".repeat(32)}`, pay_with: "QUOTE", amount: "50000000" }),
    }), testClient());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(response.headers.get("x-request-id"));
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal((body.error as { code: string }).code, "unauthorized");
  }
});
