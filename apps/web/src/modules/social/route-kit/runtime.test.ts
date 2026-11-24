import assert from "node:assert/strict";
import { primaryPool, replicaPool } from "@blast/core/modules/database/pool.ts";
import { generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

import { endProcessPools } from "../../../../../../packages/core/test/fixtures/modules/database/testing.ts";
import { installRuntimeConfig } from "../../../../../../packages/server/test/fixtures/config/runtime-config.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

/**
 * Social-feed T-002 (AC-165, AC-124): the production wiring. `me`, account
 * resolution and the kit's writes take the primary pool; the backend's
 * canonical `GET /api/social/me` owner, without a usable database, still
 * answers inside the kit (401 anonymously, 503 signed in), private and
 * no-store. The Web route is only the backend relay.
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
const APP_ID = "social-runtime-app";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();

function token(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: "did:privy:social-runtime" });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function setEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("T-002-AC-8: me, account resolution and the kit's writes use the primary pool, never the replica", async (t) => {
  const restore = setEnvironment({ DATABASE_URL: PRIMARY, DATABASE_REPLICA_URL: REPLICA });
  t.after(async () => {
    await endProcessPools();
    restore();
  });
  const primary = primaryPool();
  assert.equal(primary.options.connectionString, PRIMARY);
  assert.notEqual(primaryPool(), replicaPool());

  // The resolver and the kit's transactions take exactly that function.
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL(import.meta.resolve("@blast/server/modules/social/route-kit/shared-runtime.ts")), "utf8"));
  assert.match(source, /new PostgresSocialAccounts\(primaryPool\)/);
  assert.match(source, /primary: primaryPool/);
  assert.doesNotMatch(source, /replicaPool|databaseFor\(/);
});

test("T-002-AC-6: without a database, the backend's canonical me owner answers 401 or 503 inside the kit, private and no-store", async (t) => {
  installRuntimeConfig({
    DATABASE_URL: undefined,
    PRIVY_APP_ID: APP_ID,
    PRIVY_JWT_VERIFICATION_KEY: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  t.after(endProcessPools);
  // The exact dispatch the Bun backend serves for the browser `social.me` contract.
  const { privateRoute } = await import("@blast/core/modules/backend-api/private-routes.ts");
  const { privateApi } = await import("@blast/server/private/api.ts");
  const route = privateRoute("GET", "/api/social/me", "browser");
  assert.equal(route?.id, "social.me");
  const context = { proof: { route }, client: testClient() } as Parameters<typeof privateApi>[1];
  const GET = (request: Request) => privateApi(request, context);
  const url = "https://www.blast.fun/api/social/me";
  for (const [response, code, status] of [
    [await GET(new Request(url)), "unauthorized", 401],
    [await GET(new Request(url, { headers: { authorization: `Bearer ${token()}` } })), "service_unavailable", 503],
  ] as const) {
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, status);
    assert.equal(body.error.code, code);
    // The kit's own refusal, not the dispatcher's catch-all 503.
    if (status === 503) assert.equal(body.error.message, "The service is temporarily unavailable.");
    assert.deepEqual(validator.validate("error", body).errors, []);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(response.headers.get("x-request-id"));
    assert.equal(response.headers.has("retry-after"), status === 503);
  }
});

test("OA-7: the production kit hides trades unless the trading flag shows them", async (t) => {
  installRuntimeConfig({ NODE_ENV: "test" });
  t.after(setEnvironment({ BLAST_TRADING_ENABLED: undefined }));
  const { socialRouteKit } = await import("@blast/server/modules/social/route-kit/shared-runtime.ts");
  const route = socialRouteKit().route({ name: "GET /api/social/test", auth: "none" }, async (context) => context.json(context.hiddenKinds));
  const read = async () => (await route(new Request("https://www.blast.fun/api/social/test"), testClient())).json();
  assert.deepEqual(await read(), ["trade_buy", "trade_sell"]);
  process.env.BLAST_TRADING_ENABLED = "true";
  assert.deepEqual(await read(), []);
});

test("me fails closed on invalid Privy configuration before quota or account reads, without clearing the session", async (t) => {
  const { socialRouteKit } = await import("@blast/server/modules/social/route-kit/shared-runtime.ts");
  const { createSocialMeRoute } = await import("@blast/server/modules/social/accounts/me-route.ts");
  let quotaCalls = 0;
  t.mock.method(PostgresRateLimitEnforcer.prototype, "consume", async () => {
    quotaCalls += 1;
    throw new Error("Quota must not run before authentication");
  });
  const logs: string[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(line));
  const wrongCurve = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const accessToken = token();
  const cookie = `__Host-blast_wallet=${"s".repeat(43)}`;

  // A missing PRIVY_APP_ID or key stops boot (runtime-config.test.ts); a present but unusable key fails per request.
  for (const configuration of [
    { PRIVY_APP_ID: APP_ID, PRIVY_JWT_VERIFICATION_KEY: "not-a-public-key" },
    { PRIVY_APP_ID: APP_ID, PRIVY_JWT_VERIFICATION_KEY: wrongCurve.publicKey.export({ format: "pem", type: "spki" }).toString() },
  ]) {
    let walletReads = 0;
    installRuntimeConfig({ ...configuration, NODE_ENV: "test" });
    const kit = socialRouteKit();
    const route = createSocialMeRoute({
      kit,
      accounts: {
        async resolveWithWallets() { walletReads += 1; return null; },
        async resolveWalletWithWallets() { walletReads += 1; return null; },
      },
    });
    const response = await route.GET(new Request("https://www.blast.fun/api/social/me", {
      headers: { authorization: `Bearer ${accessToken}`, cookie, "sec-fetch-site": "same-origin" },
    }), testClient());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "service_unavailable", message: "The service is temporarily unavailable." },
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(quotaCalls, 0);
    assert.equal(walletReads, 0);
    const metric = JSON.parse(logs.at(-1)!);
    assert.equal(metric.cause, "INVALID_CONFIGURATION");
    assert.equal(metric.requestId, response.headers.get("x-request-id"));
  }
  assert.equal(logs.some((line) => line.includes(accessToken) || line.includes("PUBLIC KEY") || line.includes(cookie)), false);
});
