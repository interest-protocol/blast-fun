import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import type { AccountSettings } from "@blast/core/modules/presale/contracts/account-settings.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { PostgresAccountSettingsStore } from "@blast/server/modules/presale/settings/repository.ts";
import { createAccountSettingsRoutes, presaleSettingsDefaults, type AccountSettingsStore } from "@blast/server/modules/presale/settings/routes.ts";

/**
 * T-010 (REQ-025, AC-102..AC-104): `GET|PUT /api/account/settings` as
 * Request -> Response handlers, with a real Privy token verifier over a
 * fixture key, an in-memory store and an in-memory rate-limit port. The
 * Postgres store and the real `presale_settings` budget are in
 * settings.integration.test.ts.
 */

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-settings-app";
const NOW = Math.floor(Date.now() / 1_000);
const DID = "did:privy:presale-settings-user";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createPresaleValidator();

function token(claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: DID, ...claims });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

class MemoryLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  }
}

/** Saved settings by DID; every save is recorded. */
class MemoryStore implements AccountSettingsStore {
  readonly rows = new Map<string, AccountSettings>();
  async find(did: string): Promise<AccountSettings | null> {
    return this.rows.get(did) ?? null;
  }
  async save(did: string, settings: AccountSettings): Promise<void> {
    this.rows.set(did, { ...settings });
  }
}

function routes(options: { defaults?: AccountSettings; store?: AccountSettingsStore; limiter?: MemoryLimiter } = {}) {
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter: options.limiter ?? new MemoryLimiter(),
    deployment: createPresaleDeploymentGate({
      environment: {},
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
  });
  return createAccountSettingsRoutes({ kit, store: options.store ?? new MemoryStore(), defaults: options.defaults ?? presaleSettingsDefaults({}) });
}

function get(headers: Record<string, string> = { authorization: `Bearer ${token()}` }): Request {
  return new Request(`${ORIGIN}/api/account/settings`, { headers });
}

/** A 200 settings body, checked against the published response schema. */
async function settingsBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("account-settings-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}

test("an account with nothing saved gets the shipped defaults, unsaved", async () => {
  const response = await routes().GET(get(), testClient());
  assert.deepEqual(await settingsBody(response), { explorer: "suivision", theme: "system", saved: false });
});

test("an account with nothing saved gets the configured defaults when they are set", async () => {
  const defaults = presaleSettingsDefaults({ PRESALE_DEFAULT_EXPLORER: "suiscan", PRESALE_DEFAULT_THEME: "dark" });
  const response = await routes({ defaults }).GET(get(), testClient());
  assert.deepEqual(await settingsBody(response), { explorer: "suiscan", theme: "dark", saved: false });
  const themeOnly = await routes({ defaults: presaleSettingsDefaults({ PRESALE_DEFAULT_THEME: "light" }) }).GET(get(), testClient());
  assert.deepEqual(await settingsBody(themeOnly), { explorer: "suivision", theme: "light", saved: false });
});

/** Asserts a published error: status, code, closed schema and the kit's headers. */
async function assertError(response: Response, code: PresaleErrorCode): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function put(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/account/settings`, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...headers },
  });
}

test("PUT stores both values and returns them saved; a later GET with another token for the DID returns them", async () => {
  const store = new MemoryStore();
  const settings = routes({ store });
  const saved = await settings.PUT(put({ explorer: "suiscan", theme: "dark" }), testClient());
  assert.deepEqual(await settingsBody(saved), { explorer: "suiscan", theme: "dark", saved: true });
  assert.deepEqual(store.rows.get(DID), { explorer: "suiscan", theme: "dark" });

  const otherDevice = get({ authorization: `Bearer ${token({ sid: "s-2", iat: NOW - 5 })}` });
  assert.deepEqual(await settingsBody(await settings.GET(otherDevice, testClient())), { explorer: "suiscan", theme: "dark", saved: true });

  const changed = await settings.PUT(put({ theme: "light", explorer: "suivision" }), testClient());
  assert.deepEqual(await settingsBody(changed), { explorer: "suivision", theme: "light", saved: true });
  assert.deepEqual(await settingsBody(await settings.GET(get(), testClient())), { explorer: "suivision", theme: "light", saved: true });
});

test("an unknown key, a missing key or an out-of-enum value is invalid_settings and leaves the saved row unchanged", async () => {
  const store = new MemoryStore();
  const settings = routes({ store });
  const before: AccountSettings = { explorer: "suiscan", theme: "dark" };
  store.rows.set(DID, { ...before });
  const invalid: [string, unknown][] = [
    ["unknown key", { explorer: "suivision", theme: "light", saved: true }],
    ["unknown key only", { explorer: "suivision", theme: "light", language: "en" }],
    ["missing theme", { explorer: "suivision" }],
    ["missing explorer", { theme: "light" }],
    ["empty object", {}],
    ["out-of-enum explorer", { explorer: "etherscan", theme: "light" }],
    ["out-of-enum theme", { explorer: "suivision", theme: "Dark" }],
    ["null value", { explorer: null, theme: "light" }],
    ["not an object", ["suivision", "light"]],
    ["null body", null],
    ["a string body", "\"suivision\""],
  ];
  for (const [label, body] of invalid) {
    await assertError(await settings.PUT(put(body), testClient()), "invalid_settings").catch((error: unknown) => {
      throw new Error(`${label}: ${String(error)}`);
    });
    assert.deepEqual(store.rows.get(DID), before, `${label}: the saved row is unchanged`);
  }
  assert.deepEqual(await settingsBody(await settings.GET(get(), testClient())), { ...before, saved: true });

  // An account with nothing saved still has nothing saved after a refused PUT.
  const empty = new MemoryStore();
  await assertError(await routes({ store: empty }).PUT(put({ explorer: "suiscan" }), testClient()), "invalid_settings");
  assert.equal(empty.rows.size, 0);
});

test("a missing or invalid token is 401 unauthorized, and nothing is read or stored", async () => {
  const store = new MemoryStore();
  const limiter = new MemoryLimiter();
  const settings = routes({ store, limiter });
  await assertError(await settings.GET(get({}), testClient()), "unauthorized");
  await assertError(await settings.PUT(put({ explorer: "suiscan", theme: "dark" }, { authorization: "" }), testClient()), "unauthorized");
  await assertError(await settings.GET(get({ authorization: `Bearer ${token({ aud: "another-app" })}` }), testClient()), "unauthorized");
  await assertError(await settings.PUT(put({ explorer: "suiscan", theme: "dark" }, {
    authorization: `Bearer ${token({ exp: NOW - 3_600 })}`,
  }), testClient()), "unauthorized");
  assert.equal(store.rows.size, 0);
  assert.equal(limiter.calls.length, 0, "an anonymous request spends no account budget");
});

test("every request counts in presale_settings for its account", async () => {
  const limiter = new MemoryLimiter();
  const settings = routes({ limiter });
  await settings.GET(get(), testClient());
  await settings.PUT(put({ explorer: "suiscan", theme: "dark" }), testClient());
  await settings.PUT(put({ explorer: "suiscan" }), testClient());
  assert.deepEqual(limiter.calls.map((call) => [call.bucket, call.subject.accountId]), [
    ["presale_settings", DID],
    ["presale_settings", DID],
    ["presale_settings", DID],
  ]);
});

test("a PUT body that is not JSON is the kit's invalid_request, and nothing is stored", async () => {
  const store = new MemoryStore();
  const settings = routes({ store });
  await assertError(await settings.PUT(put("{\"explorer\":"), testClient()), "invalid_request");
  await assertError(await settings.PUT(put({ explorer: "suiscan", theme: "dark" }, { "content-type": "text/plain" }), testClient()), "invalid_request");
  assert.equal(store.rows.size, 0);
});

test("the Postgres store resolves its pool per call, so a database configuration error is service_unavailable", async () => {
  let resolved = 0;
  const store = new PostgresAccountSettingsStore(() => {
    resolved += 1;
    throw new Error("DATABASE_URL is required.");
  });
  const settings = routes({ store });
  assert.equal(resolved, 0, "building the handlers resolves no pool");
  await assertError(await settings.GET(get({}), testClient()), "unauthorized");
  assert.equal(resolved, 0, "an anonymous request resolves no pool");
  await assertError(await settings.GET(get(), testClient()), "service_unavailable");
  await assertError(await settings.PUT(put({ explorer: "suiscan", theme: "dark" }), testClient()), "service_unavailable");
  assert.equal(resolved, 2);
});
