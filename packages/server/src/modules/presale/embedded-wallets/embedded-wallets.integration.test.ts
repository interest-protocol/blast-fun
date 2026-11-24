import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";

import {
  SYNTHETIC_GOOGLE_PRIVY_DID,
  SYNTHETIC_GOOGLE_SUI_ADDRESS,
  syntheticGoogleOnlyUser,
} from "../../../../../core/test/fixtures/lib/privy-adapter/fixtures.ts";
import { createPrivyHttpGateway } from "@blast/server/lib/privy-adapter/http-gateway.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { createPresaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/service.ts";

/**
 * T-008 (AC-030, AC-136 support): the caller's embedded Sui wallet through
 * the real Privy HTTP gateway over a fixture `fetch` (no network, no
 * credentials) and the Postgres DID → address cache.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const verificationKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .publicKey.export({ format: "pem", type: "spki" })
  .toString();

/** A fixture Privy users API: `users` by DID, or a 503 outage. */
function fixturePrivy() {
  const state = { outage: false, requests: [] as string[], users: new Map<string, unknown>() };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    state.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (state.outage) return new Response("unavailable", { status: 503 });
    const did = decodeURIComponent(url.pathname.replace(/^\/v1\/users\//, ""));
    const user = state.users.get(did);
    return user ? Response.json(user) : new Response("{}", { status: 404 });
  };
  const gateway = createPrivyHttpGateway({
    appId: "presale-fixture-app",
    appSecret: "fixture-secret-not-a-credential",
    baseUrl: "https://privy.fixture.test",
    fetch,
    jwtVerificationKey: verificationKey,
    sleep: async () => undefined,
  });
  return { gateway, state };
}

test("the embedded wallet resolves for a Google-only user, is cached, and survives a Privy outage", { skip }, async () => {
  assert.ok(databaseUrl);
  const pool = createPool(databaseUrl, { max: 4 });
  try {
    await migrateDatabase(pool);
    await pool.query("DELETE FROM presale_embedded_wallets");
    const privy = fixturePrivy();
    privy.state.users.set(SYNTHETIC_GOOGLE_PRIVY_DID, syntheticGoogleOnlyUser());
    const wallets = createPresaleEmbeddedWallets({ pool, gateway: privy.gateway });

    assert.equal(await wallets.require(SYNTHETIC_GOOGLE_PRIVY_DID), SYNTHETIC_GOOGLE_SUI_ADDRESS);
    const rows = await pool.query("SELECT privy_did, address FROM presale_embedded_wallets");
    assert.deepEqual(rows.rows, [{ privy_did: SYNTHETIC_GOOGLE_PRIVY_DID, address: SYNTHETIC_GOOGLE_SUI_ADDRESS }]);

    privy.state.outage = true;
    privy.state.requests.length = 0;
    assert.equal(await wallets.require(SYNTHETIC_GOOGLE_PRIVY_DID), SYNTHETIC_GOOGLE_SUI_ADDRESS, "cached during the outage");
    assert.equal(privy.state.requests.length, 0, "a cached DID never calls Privy");

    // A cache miss during the outage: identity_unavailable, Retry-After 5.
    const missed = "did:privy:presale-uncached";
    privy.state.users.set(missed, { ...syntheticGoogleOnlyUser(), id: missed });
    await assert.rejects(wallets.require(missed), (error: unknown) =>
      error instanceof PresaleRouteError && error.code === "identity_unavailable" && error.retryAfterSeconds === 5);
    await assert.rejects(wallets.find(missed), (error: unknown) =>
      error instanceof PresaleRouteError && error.code === "identity_unavailable");
    assert.deepEqual(privy.state.requests.slice(0, 3), Array(3).fill(`GET /v1/users/${encodeURIComponent(missed)}`));

    privy.state.outage = false;
    const walletless = "did:privy:presale-walletless";
    privy.state.users.set(walletless, { ...syntheticGoogleOnlyUser({ wallet: false }), id: walletless });
    await assert.rejects(wallets.require(walletless), (error: unknown) =>
      error instanceof PresaleRouteError && error.code === "not_embedded_wallet");
    assert.equal(await wallets.find(walletless), null, "the linked-wallet list reads a missing wallet as none");
    assert.ok(!privy.state.requests.some((request) => request.startsWith("POST")), "the resolver never creates a wallet");

    // A misconfigured Privy gateway is a deployment fault, not a Privy outage (Q-002, B-006):
    // a cache miss is service_unavailable, and a cached DID still resolves.
    const unconfigured = createPresaleEmbeddedWallets({
      pool,
      gateway: { getUser: () => Promise.reject(new PrivyAdapterError("INVALID_CONFIGURATION")) },
    });
    await assert.rejects(unconfigured.find("did:privy:presale-never-seen"), (error: unknown) =>
      error instanceof PresaleRouteError && error.code === "service_unavailable" && error.retryAfterSeconds === 5);
    assert.equal(await unconfigured.require(SYNTHETIC_GOOGLE_PRIVY_DID), SYNTHETIC_GOOGLE_SUI_ADDRESS);

    // Concurrent first resolutions of one DID store one row.
    await pool.query("DELETE FROM presale_embedded_wallets");
    const results = await Promise.all(Array.from({ length: 5 }, () => wallets.require(missed)));
    assert.deepEqual(new Set(results), new Set([SYNTHETIC_GOOGLE_SUI_ADDRESS]));
    const stored = await pool.query("SELECT count(*)::int AS count FROM presale_embedded_wallets");
    assert.equal(stored.rows[0].count, 1);
  } finally {
    await pool.end();
  }
});
