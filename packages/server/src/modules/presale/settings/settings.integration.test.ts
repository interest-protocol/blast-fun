import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import type { PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { PostgresAccountSettingsStore } from "@blast/server/modules/presale/settings/repository.ts";
import { createAccountSettingsRoutes, presaleSettingsDefaults } from "@blast/server/modules/presale/settings/routes.ts";

/**
 * T-010 (AC-102..AC-104, AC-107 support): the settings routes over
 * `presale_account_settings` (migration 0045) and the real `presale_settings`
 * budget, both as the web runtime role `blast_web`, with a real Privy token
 * verifier over a fixture key (no provider call).
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "presale-settings-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "presale-settings-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createPresaleValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 2_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 500,
  max: 4,
  statementTimeoutMs: 5_000,
};

function token(did: string, session = "s-1"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: session, sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function settingsRoutes(pool: Pool, options: { environment?: Readonly<Record<string, string | undefined>>; now?: () => Date } = {}) {
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter: new PostgresRateLimitEnforcer({ pool, subjectPepper: PEPPER, clock: options.now }),
    deployment: createPresaleDeploymentGate({ environment: {}, node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
  });
  return createAccountSettingsRoutes({ kit, store: new PostgresAccountSettingsStore(() => pool), defaults: presaleSettingsDefaults(options.environment ?? {}) });
}

const get = (did: string, session?: string) =>
  new Request(`${ORIGIN}/api/account/settings`, { headers: { authorization: `Bearer ${token(did, session)}` } });
const put = (did: string, body: unknown) =>
  new Request(`${ORIGIN}/api/account/settings`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token(did)}`, "content-type": "application/json", origin: ORIGIN },
  });

async function settingsBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("account-settings-response", body).errors, []);
  return body;
}

async function errorCode(response: Response): Promise<PresaleErrorCode> {
  const body = (await response.json()) as { error: { code: PresaleErrorCode } };
  assert.deepEqual(validator.validate(`errors/${body.error.code}`, body).errors, []);
  return body.error.code;
}

async function withDatabase(run: (pools: { admin: Pool; web: Pool }) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const web = createRuntimePool(urlAs(databaseUrl, "blast_web"), POOL_SETTINGS, "presale-settings-test");
  try {
    await migrateDatabase(admin);
    await admin.query("DELETE FROM presale_account_settings");
    await admin.query("DELETE FROM mission_control_rate_limit_windows");
    await run({ admin, web });
  } finally {
    await web.end();
    await admin.end();
  }
}

test("settings persist per Privy DID: defaults, PUT, then GET from another session", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const did = "did:privy:presale-settings-a";
    const other = "did:privy:presale-settings-b";
    const routes = settingsRoutes(web, { environment: { PRESALE_DEFAULT_THEME: "dark" } });

    assert.deepEqual(await settingsBody(await routes.GET(get(did), testClient())), { explorer: "suivision", theme: "dark", saved: false });

    assert.deepEqual(
      await settingsBody(await routes.PUT(put(did, { explorer: "suiscan", theme: "light" }), testClient())),
      { explorer: "suiscan", theme: "light", saved: true },
    );
    assert.deepEqual(await settingsBody(await routes.GET(get(did, "s-other-device"), testClient())), { explorer: "suiscan", theme: "light", saved: true });
    assert.deepEqual(await settingsBody(await routes.GET(get(other), testClient())), { explorer: "suivision", theme: "dark", saved: false });

    // A second PUT replaces both values; one row per DID.
    assert.deepEqual(
      await settingsBody(await routes.PUT(put(did, { explorer: "suivision", theme: "system" }), testClient())),
      { explorer: "suivision", theme: "system", saved: true },
    );
    assert.deepEqual(await settingsBody(await routes.GET(get(did, "s-3"), testClient())), { explorer: "suivision", theme: "system", saved: true });
    const rows = await admin.query("SELECT privy_did, explorer, theme FROM presale_account_settings ORDER BY privy_did");
    assert.deepEqual(rows.rows, [{ privy_did: did, explorer: "suivision", theme: "system" }]);
  }));

test("invalid bodies are invalid_settings and leave the stored row unchanged", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const did = "did:privy:presale-settings-invalid";
    const routes = settingsRoutes(web);
    await settingsBody(await routes.PUT(put(did, { explorer: "suiscan", theme: "dark" }), testClient()));
    const stored = async () =>
      (await admin.query("SELECT privy_did, explorer, theme, updated_at FROM presale_account_settings")).rows;
    const before = await stored();
    assert.equal(before.length, 1);

    for (const body of [
      { explorer: "suivision", theme: "light", saved: true },
      { explorer: "suivision" },
      { explorer: "suivision", theme: "midnight" },
    ]) {
      assert.equal(await errorCode(await routes.PUT(put(did, body), testClient())), "invalid_settings", JSON.stringify(body));
      assert.deepEqual(await stored(), before, JSON.stringify(body));
    }
    assert.deepEqual(await settingsBody(await routes.GET(get(did), testClient())), { explorer: "suiscan", theme: "dark", saved: true });

    // An account with no row still has none after a refused PUT.
    const fresh = "did:privy:presale-settings-fresh";
    assert.equal(await errorCode(await routes.PUT(put(fresh, { theme: "light" }), testClient())), "invalid_settings");
    assert.equal((await admin.query("SELECT 1 FROM presale_account_settings WHERE privy_did = $1", [fresh])).rowCount, 0);
  }));

test("the 31st settings request in 10 minutes is rate_limited, per account", { skip }, () =>
  withDatabase(async ({ web }) => {
    const did = "did:privy:presale-settings-busy";
    // Mid-window, so all 31 requests fall in one 600-second window.
    const now = new Date(Math.floor(Date.now() / 600_000) * 600_000 + 60_000);
    const routes = settingsRoutes(web, { now: () => now });
    for (let request = 1; request <= 30; request += 1) {
      const response = request % 2 ? await routes.GET(get(did), testClient()) : await routes.PUT(put(did, { explorer: "suiscan", theme: "dark" }), testClient());
      assert.equal(response.status, 200, `request ${request}`);
    }
    const refused = await routes.GET(get(did), testClient());
    assert.equal(refused.status, 429);
    assert.equal(await errorCode(refused), "rate_limited");
    assert.match(refused.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
    assert.equal(await errorCode(await routes.PUT(put(did, { explorer: "suivision", theme: "light" }), testClient())), "rate_limited");

    assert.equal((await routes.GET(get("did:privy:presale-settings-calm"), testClient())).status, 200, "another account has its own budget");
  }));
