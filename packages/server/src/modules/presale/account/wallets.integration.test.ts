import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { syntheticGoogleOnlyUser } from "../../../../../core/test/fixtures/lib/privy-adapter/fixtures.ts";
import { createPrivyHttpGateway } from "@blast/server/lib/privy-adapter/http-gateway.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import type { PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import type { AccountWalletsResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { PostgresLinkedWalletStore } from "@blast/server/modules/presale/account/repository.ts";
import { createAccountWalletsRoutes } from "@blast/server/modules/presale/account/wallets.ts";

/**
 * T-011 (AC-136, AC-137, AC-107 support): `GET /api/account/wallets` over the
 * account tables of migration 0012 (read only) and the real
 * `presale_account_wallets` budget, both as the web runtime role `blast_web`,
 * with a real Privy token verifier over a fixture key and the real Privy HTTP
 * gateway over a fixture `fetch` (no network, no credentials).
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "presale-account-wallets-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "presale-account-wallets-fixture-pepper-0123";
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
const address = (byte: string) => `0x${byte.repeat(32)}`;

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/** A fixture Privy users API: each DID's embedded Sui wallet (null for none), or a 503 outage. */
function fixturePrivy() {
  const state = { outage: false, requests: [] as string[], embedded: new Map<string, string | null>() };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    state.requests.push(url.pathname);
    if (state.outage) return new Response("unavailable", { status: 503 });
    const did = decodeURIComponent(url.pathname.replace(/^\/v1\/users\//, ""));
    if (!state.embedded.has(did)) return new Response("{}", { status: 404 });
    const embedded = state.embedded.get(did) ?? null;
    const user = syntheticGoogleOnlyUser({ wallet: embedded !== null });
    const linked = user.linked_accounts.map((account) =>
      account.id === "wallet-google-embedded" ? { ...account, address: embedded } : account);
    return Response.json({ id: did, linked_accounts: linked });
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

function walletsRoutes(web: Pool, gateway: ReturnType<typeof fixturePrivy>["gateway"], now?: () => Date) {
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER, clock: now }),
    deployment: createPresaleDeploymentGate({ environment: {}, node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
  });
  return createAccountWalletsRoutes({
    kit,
    store: new PostgresLinkedWalletStore(() => web),
    embeddedWallets: createPresaleEmbeddedWallets({ pool: web, gateway }),
  });
}

const get = (did: string | null) =>
  new Request(`${ORIGIN}/api/account/wallets`, { headers: did ? { authorization: `Bearer ${token(did)}` } : {} });

async function walletsBody(response: Response): Promise<AccountWalletsResponse> {
  const body = (await response.json()) as AccountWalletsResponse;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("account-wallets-response", body).errors, []);
  return body;
}

async function errorCode(response: Response): Promise<PresaleErrorCode> {
  const body = (await response.json()) as { error: { code: PresaleErrorCode } };
  assert.deepEqual(validator.validate(`errors/${body.error.code}`, body).errors, []);
  return body.error.code;
}

let profiles = 0;

/** A Blast Account profile with a Privy identity (and any others) and its wallets, seeded as the owner would. */
async function blastAccount(admin: Pool, options: Readonly<{
  privyDid: string | null;
  identities?: readonly [provider: "x" | "google", subject: string][];
  wallets: readonly [kind: "embedded" | "slush", address: string, primary: boolean][];
}>): Promise<string> {
  profiles += 1;
  const profileId = randomUUID();
  await admin.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign,
       disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'v1', now())`,
    [profileId, `did:privy:legacy-${profileId}`, `x-${profileId}`, address(`e${profiles}`), `privy:legacy-${profileId}`, `wallets_${profiles}`],
  );
  const identities: [string, string][] = [...(options.identities ?? [])];
  if (options.privyDid) identities.push(["privy", options.privyDid]);
  for (const [provider, subject] of identities) {
    await admin.query(
      `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
       VALUES ($1, $2, $3, now())`,
      [profileId, provider, subject],
    );
  }
  for (const [kind, wallet, primary] of options.wallets) {
    await admin.query(
      `INSERT INTO mission_control_account_wallets (
         wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, is_primary, verified_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [randomUUID(), profileId, kind, wallet, `${kind}:${wallet}`, primary],
    );
  }
  return profileId;
}

/** Every row of both account tables, to show the route never writes them. */
async function accountTables(admin: Pool): Promise<unknown> {
  const identities = await admin.query("SELECT * FROM mission_control_account_identities ORDER BY profile_id, provider");
  const wallets = await admin.query("SELECT * FROM mission_control_account_wallets ORDER BY wallet_id");
  return { identities: identities.rows, wallets: wallets.rows };
}

async function withDatabase(run: (pools: { admin: Pool; web: Pool }) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const web = createRuntimePool(urlAs(databaseUrl, "blast_web"), POOL_SETTINGS, "presale-account-wallets-test");
  try {
    await migrateDatabase(admin);
    await admin.query("DELETE FROM presale_embedded_wallets");
    await admin.query("DELETE FROM mission_control_rate_limit_windows");
    await run({ admin, web });
  } finally {
    await web.end();
    await admin.end();
  }
}

test("each account shape gets its exact wallet list, and the account tables are only read", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const privy = fixturePrivy();
    const routes = walletsRoutes(web, privy.gateway);

    // A Blast Account with an embedded (primary) and a Slush wallet; the Privy embedded wallet is another address.
    const both = "did:privy:wallets-both";
    await blastAccount(admin, { privyDid: both, wallets: [["slush", address("2a"), false], ["embedded", address("1a"), true]] });
    privy.state.embedded.set(both, address("3a"));

    // A Blast Account whose embedded wallet is the Privy embedded wallet.
    const same = "did:privy:wallets-same";
    await blastAccount(admin, { privyDid: same, wallets: [["embedded", address("1b"), false], ["slush", address("2b"), true]] });
    privy.state.embedded.set(same, address("1b"));

    // No Blast Account profile. Another profile's X identity carries this DID as its subject and must not match.
    const none = "did:privy:wallets-none";
    await blastAccount(admin, { privyDid: null, identities: [["x", none]], wallets: [["slush", address("2c"), true]] });
    privy.state.embedded.set(none, address("3c"));

    // Neither a profile nor an embedded wallet.
    const empty = "did:privy:wallets-empty";
    privy.state.embedded.set(empty, null);

    const before = await accountTables(admin);

    assert.deepEqual(await walletsBody(await routes.GET(get(both), testClient())), {
      wallets: [
        { address: address("1a"), kind: "embedded", primary: true },
        { address: address("2a"), kind: "slush", primary: false },
        { address: address("3a"), kind: "embedded", primary: false },
      ],
    });
    assert.deepEqual(await walletsBody(await routes.GET(get(same), testClient())), {
      wallets: [
        { address: address("2b"), kind: "slush", primary: true },
        { address: address("1b"), kind: "embedded", primary: false },
      ],
    });
    assert.deepEqual(await walletsBody(await routes.GET(get(none), testClient())), {
      wallets: [{ address: address("3c"), kind: "embedded", primary: true }],
    });
    assert.deepEqual(await walletsBody(await routes.GET(get(empty), testClient())), { wallets: [] });

    assert.equal(await errorCode(await routes.GET(get(null), testClient())), "unauthorized");
    const forged = new Request(`${ORIGIN}/api/account/wallets`, { headers: { authorization: "Bearer not-a-token" } });
    assert.equal(await errorCode(await routes.GET(forged, testClient())), "unauthorized");

    assert.deepEqual(await accountTables(admin), before, "the account tables are unchanged");
    assert.ok(!privy.state.requests.some((path) => !path.startsWith("/v1/users/")), "Privy is only read");
  }));

test("a Privy outage fails an uncached DID with 503 and Retry-After; a cached DID still answers", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const privy = fixturePrivy();
    const routes = walletsRoutes(web, privy.gateway);
    const cached = "did:privy:wallets-cached";
    await blastAccount(admin, { privyDid: cached, wallets: [["slush", address("2d"), true]] });
    privy.state.embedded.set(cached, address("3d"));
    const expected = {
      wallets: [
        { address: address("2d"), kind: "slush", primary: true },
        { address: address("3d"), kind: "embedded", primary: false },
      ],
    };
    assert.deepEqual(await walletsBody(await routes.GET(get(cached), testClient())), expected);

    privy.state.outage = true;
    assert.deepEqual(await walletsBody(await routes.GET(get(cached), testClient())), expected, "cached during the outage");
    const uncached = "did:privy:wallets-uncached";
    privy.state.embedded.set(uncached, address("3e"));
    const failed = await routes.GET(get(uncached), testClient());
    assert.equal(failed.status, 503);
    assert.equal(await errorCode(failed), "service_unavailable");
    assert.match(failed.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
  }));

test("the 61st wallets request in 10 minutes is rate_limited, per account", { skip }, () =>
  withDatabase(async ({ web }) => {
    const privy = fixturePrivy();
    const busy = "did:privy:wallets-busy";
    const calm = "did:privy:wallets-calm";
    privy.state.embedded.set(busy, address("3f"));
    privy.state.embedded.set(calm, address("4f"));
    // Mid-window, so all 61 requests fall in one 600-second window.
    const now = new Date(Math.floor(Date.now() / 600_000) * 600_000 + 60_000);
    const routes = walletsRoutes(web, privy.gateway, () => now);
    for (let request = 1; request <= 60; request += 1) {
      assert.equal((await routes.GET(get(busy), testClient())).status, 200, `request ${request}`);
    }
    const refused = await routes.GET(get(busy), testClient());
    assert.equal(refused.status, 429);
    assert.equal(await errorCode(refused), "rate_limited");
    assert.match(refused.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
    assert.equal((await routes.GET(get(calm), testClient())).status, 200, "another account has its own budget");
  }));
