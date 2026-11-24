import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Pool } from "pg";

import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import {
  walletChallengeRateLimiter,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { WalletChallengeService } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { syntheticEmbeddedSigner, syntheticSlushSigner } from "../../../../../../packages/core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import { createSocialAccountCreationRoutes } from "@blast/server/modules/social/accounts/creation-routes.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialSettingsRoute } from "@blast/server/modules/social/accounts/settings-route.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialValidator, type SocialSchemaName } from "@blast/core/modules/social/contracts/validate.ts";
import type { SocialWalletChallengeResponse } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialFollowRoutes } from "@blast/server/modules/social/follows/route.ts";
import { createSocialOnboardingRoutes } from "@blast/server/modules/social/onboarding/routes.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createSocialWalletSignInRoutes } from "@blast/server/modules/social/wallet-sign-in/routes.ts";
import { liveWalletSession } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { fetchSocialAccount } from "#web/components/social/social-account-client.ts";
import { installRuntimeConfig } from "../../../../../../packages/server/test/fixtures/config/runtime-config.ts";

/**
 * Social UI-08 / OA-16: wallet sign-in (Slush) without Privy, over the
 * migrations as the web runtime role, with Mission Control's real wallet
 * challenge service, real Sui signatures (Ed25519 and secp256k1 keypairs,
 * verified offline), the Postgres rate limiter, a controllable clock and the
 * real social routes (me, accounts, follows, settings, onboarding) behind one
 * route kit that takes a Privy token or the wallet session cookie. Covers the
 * nonce, single use, expiry, origin binding, rate limits, the session and its
 * idle and absolute ends, sign-out, CSRF refusals, account resolution by a
 * linked address and a wallet-only account's whole onboarding.
 */

// The default wallet verifier reads its node URL from the API runtime config.
installRuntimeConfig();

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const PRIVY_DID = "did:privy:wallet-test-privy-user";
const PEPPER = "social-wallet-sign-in-fixture-pepper-0123456789";
const validator = createSocialValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 4_000,
  max: 8,
  statementTimeoutMs: 5_000,
};

type Signer = Readonly<{ toSuiAddress(): string; signPersonalMessage(bytes: Uint8Array): Promise<{ signature: string }> }>;

let ipSequence = 0;
const nextIp = () => `198.51.100.${(ipSequence += 1) % 250}`;

function request(
  path: string,
  init: Readonly<{ method?: string; body?: unknown; ip?: string; origin?: string | null; cookie?: string; site?: string }> = {},
): readonly [Request, ReturnType<typeof testClient>] {
  const ip = init.ip ?? nextIp();
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.site) headers["sec-fetch-site"] = init.site;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return [new Request(`${ORIGIN}/api/social/sign-in/${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  }), testClient(ip)] as const;
}

async function ok<T>(response: Response, status: number, schema: SocialSchemaName | null): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  assert.ok(response.headers.get("x-request-id"));
  const body = JSON.parse(text) as T;
  if (schema) assert.deepEqual(validator.validate(schema, body).errors, []);
  return body;
}

async function refusal(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

/** The cookies a response sets, by name, with their attributes. */
function setCookies(response: Response): Map<string, string> {
  return new Map(response.headers.getSetCookie().map((cookie) => [cookie.slice(0, cookie.indexOf("=")), cookie]));
}

function sessionCookieHeader(response: Response): string {
  const cookie = setCookies(response).get("__Host-blast_wallet");
  assert.ok(cookie);
  return cookie.slice(0, cookie.indexOf(";"));
}

/** A social route call as the browser makes it with the wallet session cookie (same-origin). */
function api(
  path: string,
  init: Readonly<{ method?: string; body?: unknown; cookie?: string; origin?: string | null; site?: string | null; bearer?: string }> = {},
): readonly [Request, ReturnType<typeof testClient>] {
  const method = init.method ?? "GET";
  const ip = nextIp();
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.site !== null) headers["sec-fetch-site"] = init.site ?? "same-origin";
  // Browsers send Origin on a same-origin write, not on a same-origin GET.
  const origin = init.origin === undefined ? (method === "GET" ? null : ORIGIN) : init.origin;
  if (origin) headers.origin = origin;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return [new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), testClient(ip)] as const;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
}

async function me(fixture: Fixture, cookie: string): Promise<SocialMeResponse> {
  return ok<SocialMeResponse>(await fixture.social.me.GET(...api("/api/social/me", { cookie })), 200, "me-response");
}

type Fixture = Readonly<{
  admin: Pool;
  web: Pool;
  routes: ReturnType<typeof createSocialWalletSignInRoutes>;
  social: Readonly<{
    me: ReturnType<typeof createSocialMeRoute>;
    accounts: ReturnType<typeof createSocialAccountCreationRoutes>;
    follows: ReturnType<typeof createSocialFollowRoutes>;
    settings: ReturnType<typeof createSocialSettingsRoute>;
    onboarding: ReturnType<typeof createSocialOnboardingRoutes>;
  }>;
  clock: { now: Date };
  /** Challenge, sign and prove: answers the 201 response. */
  signIn(signer: Signer, ip?: string): Promise<Response>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL_SETTINGS, "social-wallet-sign-in-test");
  try {
    const clock = { now: new Date("2026-10-03T12:00:00.000Z") };
    const limiter = new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER, clock: () => clock.now });
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      // A stub verifier: "privy:<did>" is a valid Privy token for <did>.
      verifyAccessToken: async (token) => {
        if (!token.startsWith("privy:")) throw new Error("invalid token");
        return { userId: token.slice("privy:".length) } as never;
      },
      limiter,
      accounts,
      walletSessions: {
        live: (token) =>
          liveWalletSession(web, token, clock.now),
      },
      primary: () => web,
    });
    const config = createSocialConfigReader(autocommitReader(web, "social"), { ttlMs: 0 });
    const social = {
      me: createSocialMeRoute({ kit, accounts }),
      accounts: createSocialAccountCreationRoutes({
        kit,
        accounts,
        privyUsers: { getUser: async (did: string) => ({ id: did, linked_accounts: [] }) },
        findBlockedTerm: config.findBlockedTerm,
      }),
      follows: createSocialFollowRoutes({ kit }),
      settings: createSocialSettingsRoute({ kit }),
      onboarding: createSocialOnboardingRoutes({ kit }),
    };
    const challenges = new WalletChallengeService(web, {
      clock: () => clock.now,
      rateLimiter: walletChallengeRateLimiter(limiter),
    });
    const routes = createSocialWalletSignInRoutes({ kit, expectedOrigin: ORIGIN, challenges, clock: () => clock.now });
    await run({
      admin, web,
      routes,
      social,
      clock,
      async signIn(signer, ip = nextIp()) {
        const issued = await ok<SocialWalletChallengeResponse>(
          await routes.challenge.POST(...request("challenge", { body: { address: signer.toSuiAddress() }, ip })),
          200,
          "wallet-sign-in-challenge-response",
        );
        const { signature } = await signer.signPersonalMessage(new TextEncoder().encode(issued.message));
        return routes.session.POST(...request("session", {
          body: { challenge_id: issued.challenge_id, address: signer.toSuiAddress(), message: issued.message, signature },
          ip,
        }));
      },
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

async function sessionRows(admin: Pool): Promise<{ wallet_address: string; revoked_at: Date | null; token_hash: string }[]> {
  return (await admin.query("SELECT wallet_address, revoked_at, token_hash FROM social_wallet_sessions ORDER BY created_at")).rows;
}

async function loadAccount(fixture: Fixture, cookie: string) {
  return fetchSocialAccount({
    getAccessToken: async () => null,
    fetch: async (input, init) => {
      assert.equal(init?.credentials, "same-origin");
      if (input === "/api/social/me") {
        return fixture.social.me.GET(...api(input, { cookie }));
      }
      assert.equal(input, "/api/social/accounts");
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
      return fixture.social.accounts.create.POST(...api("/api/social/accounts", { cookie, method: "POST", body: {} }));
    },
  });
}

test("automatic wallet onboarding: the real account client saves random defaults and completion once, including after sign-in again", { skip }, () =>
  withDatabase(async (fixture) => {
    const { admin, routes, signIn } = fixture;
    const cookie = sessionCookieHeader(await signIn(syntheticSlushSigner));
    const state = await loadAccount(fixture, cookie);
    assert.equal(state.status, "ready");
    assert.ok(state.account);
    assert.equal(state.account.kind, "new");
    assert.match(state.account.callsign, /^[a-z]+_[a-z]+_\d{4}$/);
    assert.match(state.account.display_name!, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.deepEqual(state.account.onboarding, { shown: true, completed: true });
    assert.equal(state.account.privacy, "public");
    assert.ok(state.account.sharing_since_ms);
    assert.deepEqual(state.account.wallets.map(({ address, kind }) => ({ address, kind })), [
      { address: syntheticSlushSigner.toSuiAddress(), kind: "slush" },
    ]);

    // More reads than the creation quota must still keep the saved identity.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      assert.deepEqual(await loadAccount(fixture, cookie), state);
    }
    assert.equal((await routes.session.DELETE(...request("session", { method: "DELETE", cookie }))).status, 200);
    const freshCookie = sessionCookieHeader(await signIn(syntheticSlushSigner));
    assert.deepEqual(await loadAccount(fixture, freshCookie), state);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_accounts")).rows[0].count, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_account_wallets")).rows[0].count, 1);
  }));

test("automatic wallet onboarding recovers from the missing callsign migration after failed-attempt counters are cleared", { skip }, () =>
  withDatabase(async (fixture) => {
    const { admin, signIn } = fixture;
    const cookie = sessionCookieHeader(await signIn(syntheticSlushSigner));
    const down = await readFile(new URL("../../../../../../packages/core/src/modules/database/migrations/0113_social_callsign_history.down.sql", import.meta.url), "utf8");
    await admin.query(down);
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0113_social_callsign_history'");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await loadAccount(fixture, cookie);
      assert.ok(failed.requestId);
      assert.match(failed.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.deepEqual(failed, {
        status: "error",
        account: null,
        code: "service_unavailable",
        httpStatus: 503,
        requestId: failed.requestId,
        message: `Your account could not be created. Try again. Code: service_unavailable. Reference: ${failed.requestId}.`,
      });
    }
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_accounts")).rows[0].count, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_account_wallets")).rows[0].count, 0);

    assert.deepEqual(await migrateDatabase(admin), ["0113_social_callsign_history"]);
    await refused(await fixture.social.accounts.create.POST(...api("/api/social/accounts", { cookie, method: "POST", body: {} })), 429, "rate_limited");
    await admin.query("DELETE FROM mission_control_rate_limit_windows");
    const recovered = await loadAccount(fixture, cookie);
    assert.equal(recovered.status, "ready");
    assert.ok(recovered.account);
    assert.deepEqual(recovered.account.onboarding, { shown: true, completed: true });
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_accounts")).rows[0].count, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_account_wallets")).rows[0].count, 1);
  }));

test("UI-08 (OA-16): a Slush signature starts the web app's own session; it is the caller on social routes; sign-out ends it", { skip }, () =>
  withDatabase(async (fixture) => {
    const { admin, routes, signIn } = fixture;
    const address = syntheticSlushSigner.toSuiAddress();
    const issued = await ok<SocialWalletChallengeResponse>(
      await routes.challenge.POST(...request("challenge", { body: { address: address.replace(/^0x0*/, "0x").toUpperCase().replace("0X", "0x") } })),
      200,
      "wallet-sign-in-challenge-response",
    );
    // The message names the canonical address, the site's origin, a sign-in attempt and its purpose.
    assert.match(issued.message, new RegExp(`^BLAST\\.FUN wallet verification\\n\\nAction: sign_in\\nAddress: ${address}\\nOrigin: ${ORIGIN}\\nAttempt: sign-in-[0-9a-f-]{36}\\n\\nPurpose: Sign in to BLAST\\.FUN with this wallet\\nNonce: [A-Za-z0-9_-]{43}\\n`));
    assert.equal(issued.expires_at_ms, Date.parse("2026-10-03T12:05:00.000Z"));

    const created = await signIn(syntheticSlushSigner);
    const createdBody = await ok<{ expires_at_ms: number }>(created.clone(), 201, "wallet-session-response");
    assert.equal(createdBody.expires_at_ms, Date.parse("2026-11-02T12:00:00.000Z"));
    assert.equal(created.headers.get("cache-control"), "no-store");
    const cookies = setCookies(created);
    assert.match(cookies.get("__Host-blast_wallet")!, /^__Host-blast_wallet=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(cookies.get("__Host-blast_wallet_hint"), "__Host-blast_wallet_hint=1; Path=/; Max-Age=2592000; Secure; SameSite=Strict");
    const cookie = sessionCookieHeader(created);
    const [row] = await sessionRows(admin);
    assert.equal(row?.wallet_address, address);
    assert.notEqual(row?.token_hash, cookie.split("=")[1], "only the token's hash is stored");

    // The cookie is the caller on every social route (OA-16): no account yet.
    assert.deepEqual(await me(fixture, cookie), { account: null });

    // Sign-out revokes the session and clears both cookies; the cookie no longer signs in.
    const out = await routes.session.DELETE(...request("session", { method: "DELETE", cookie }));
    assert.deepEqual(await ok(out.clone(), 200, "wallet-sign-out-response"), { signed_in: false });
    assert.deepEqual([...setCookies(out).values()].map((value) => value.split(";")[0]), ["__Host-blast_wallet=", "__Host-blast_wallet_hint="]);
    assert.ok((await sessionRows(admin))[0]?.revoked_at);
    const after = await fixture.social.me.GET(...api("/api/social/me", { cookie }));
    assert.deepEqual([...setCookies(after.clone()).keys()], ["__Host-blast_wallet", "__Host-blast_wallet_hint"]);
    await refused(after, 401, "unauthorized");

    // A secp256k1 wallet signs in the same way.
    assert.equal((await signIn(syntheticEmbeddedSigner)).status, 201);
  }));

test("UI-08: a challenge works once, for five minutes, for its own address, message and signer", { skip }, () =>
  withDatabase(async ({ admin, routes, clock }) => {
    const signer = syntheticSlushSigner;
    const address = signer.toSuiAddress();
    const challenge = async () =>
      ok<SocialWalletChallengeResponse>(await routes.challenge.POST(...request("challenge", { body: { address } })), 200, null);
    const prove = (body: Record<string, unknown>) => routes.session.POST(...request("session", { body }));
    const sign = async (message: string, by: Signer = signer) =>
      (await by.signPersonalMessage(new TextEncoder().encode(message))).signature;

    // Replay: the second use of a good proof is refused and makes no session.
    const first = await challenge();
    const proof = { challenge_id: first.challenge_id, address, message: first.message, signature: await sign(first.message) };
    assert.equal((await prove(proof)).status, 201);
    await refusal(await prove(proof), 400, "wallet_proof_invalid");
    assert.equal((await sessionRows(admin)).length, 1);

    // Another signer, another address, a changed message, a message for another challenge.
    const second = await challenge();
    const other = new Ed25519Keypair();
    await refusal(await prove({ challenge_id: second.challenge_id, address, message: second.message, signature: await sign(second.message, other) }), 400, "wallet_proof_invalid");
    await refusal(await prove({ challenge_id: second.challenge_id, address: other.toSuiAddress(), message: second.message, signature: await sign(second.message, other) }), 400, "wallet_proof_invalid");
    const changed = second.message.replace("Origin: https://blast.fun", "Origin: https://evil.example");
    await refusal(await prove({ challenge_id: second.challenge_id, address, message: changed, signature: await sign(changed) }), 400, "wallet_proof_invalid");
    const third = await challenge();
    await refusal(await prove({ challenge_id: second.challenge_id, address, message: third.message, signature: await sign(third.message) }), 400, "wallet_proof_invalid");
    // The failures above did not burn the challenge: its own proof still works.
    assert.equal((await prove({ challenge_id: second.challenge_id, address, message: second.message, signature: await sign(second.message) })).status, 201);

    // Expiry: five minutes after issue the proof is refused.
    const late = await challenge();
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    await refusal(await prove({ challenge_id: late.challenge_id, address, message: late.message, signature: await sign(late.message) }), 400, "wallet_proof_invalid");
    assert.equal((await sessionRows(admin)).length, 2);

    // Closed bodies.
    for (const body of [{}, { address }, { ...proof, extra: 1 }, { ...proof, challenge_id: "nope" }, { ...proof, signature: "" }, "[]", "nope"]) {
      await refusal(await prove(body as Record<string, unknown>), 400, "invalid_request");
    }
    await refusal(await routes.challenge.POST(...request("challenge", { body: { address: "0xzz" } })), 400, "invalid_request");
    await refusal(await routes.challenge.POST(...request("challenge", { body: { address, extra: true } })), 400, "invalid_request");
  }));

test("UI-08 (OA-16): sign-in routes need the site's Origin; a cookie caller must be same-origin on every social route (CSRF)", { skip }, () =>
  withDatabase(async (fixture) => {
    const { routes, signIn, social } = fixture;
    const address = syntheticSlushSigner.toSuiAddress();
    await refusal(await routes.challenge.POST(...request("challenge", { body: { address }, origin: null })), 403, "origin_invalid");
    await refusal(await routes.challenge.POST(...request("challenge", { body: { address }, origin: "https://evil.example" })), 403, "origin_invalid");
    const cookie = sessionCookieHeader(await signIn(syntheticSlushSigner));
    await refusal(await routes.session.DELETE(...request("session", { method: "DELETE", cookie, origin: "https://evil.example" })), 403, "origin_invalid");
    await refusal(await routes.session.DELETE(...request("session", { method: "DELETE", cookie, site: "cross-site" })), 403, "origin_invalid");

    // GET: a same-origin fetch passes; no fetch metadata, or another site's, does not.
    assert.equal((await social.me.GET(...api("/api/social/me", { cookie }))).status, 200);
    await refused(await social.me.GET(...api("/api/social/me", { cookie, site: null })), 403, "origin_invalid");
    await refused(await social.me.GET(...api("/api/social/me", { cookie, site: "cross-site" })), 403, "origin_invalid");
    // Writes need Origin: missing, another origin, or a cross-site fetch is refused before anything is written.
    const create = (init: Parameters<typeof api>[1]) => social.accounts.create.POST(...api("/api/social/accounts", { method: "POST", body: { callsign: "csrf_one" }, cookie, ...init }));
    await refused(await create({ origin: null }), 403, "origin_invalid");
    await refused(await create({ origin: "https://evil.example" }), 403, "origin_invalid");
    await refused(await create({ site: "same-site" }), 403, "origin_invalid");
    assert.deepEqual(await me(fixture, cookie), { account: null }, "nothing was created");
    // Malformed, duplicated or missing cookies are no caller.
    await refused(await social.me.GET(...api("/api/social/me", {})), 401, "unauthorized");
    await refused(await social.me.GET(...api("/api/social/me", { cookie: "__Host-blast_wallet=short" })), 401, "unauthorized");
    await refused(await social.me.GET(...api("/api/social/me", { cookie: `${cookie}; ${cookie}` })), 401, "unauthorized");
  }));

test("session touch rechecks a revocation racing the initial read", { skip }, () =>
  withDatabase(async ({ admin, web, clock, signIn }) => {
    const token = sessionCookieHeader(await signIn(syntheticSlushSigner)).split("=")[1]!;
    const before = (await admin.query("SELECT last_used_at FROM social_wallet_sessions")).rows[0].last_used_at;
    clock.now = new Date(clock.now.getTime() + 11 * 60_000);
    let raced = false;
    const racing = new Proxy(web, {
      get(target, property) {
        if (property === "connect") return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(inner, name) {
              if (name === "query") return async (config: string | { text: string }, values?: unknown[]) => {
                const sql = typeof config === "string" ? config : config.text;
                if (sql.startsWith("UPDATE social_wallet_sessions")) {
                  raced = true;
                  await admin.query("UPDATE social_wallet_sessions SET revoked_at=$1", [clock.now]);
                }
                return inner.query(config, values);
              };
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.equal(await liveWalletSession(racing, token, clock.now), null);
    assert(raced);
    assert.deepEqual((await admin.query("SELECT last_used_at FROM social_wallet_sessions")).rows[0].last_used_at, before);
  }));

test("UI-08: a session ends after 7 idle days or 30 days; use keeps it alive; expired rows are swept", { skip }, () =>
  withDatabase(async ({ admin, social, clock, signIn }) => {
    const day = 86_400_000;
    const cookie = sessionCookieHeader(await signIn(syntheticSlushSigner));
    const token = (at: number) => {
      clock.now = new Date(Date.parse("2026-10-03T12:00:00.000Z") + at);
      return social.me.GET(...api("/api/social/me", { cookie }));
    };
    // Used every 6 days, it lives to its 30th day and no further.
    for (const at of [6, 12, 18, 24, 29.9]) assert.equal((await token(at * day)).status, 200, String(at));
    await refused(await token(30 * day), 401, "unauthorized");

    // Idle for 7 days, it ends.
    clock.now = new Date("2026-10-03T12:00:00.000Z");
    const idle = sessionCookieHeader(await signIn(syntheticEmbeddedSigner));
    clock.now = new Date(Date.parse("2026-10-03T12:00:00.000Z") + 7 * day);
    await refused(await social.me.GET(...api("/api/social/me", { cookie: idle })), 401, "unauthorized");

    // A new session sweeps expired ones.
    clock.now = new Date(Date.parse("2026-10-03T12:00:00.000Z") + 31 * day);
    assert.equal((await signIn(syntheticSlushSigner)).status, 201);
    assert.equal((await sessionRows(admin)).length, 1);
  }));

test("UI-08: sign-in attempts are limited per IP (20 per 10 minutes) and per IP and address (5 per operation)", { skip }, () =>
  withDatabase(async ({ routes, signIn }) => {
    const ip = "203.0.113.9";
    // Per IP and address: the sixth challenge for one wallet from one IP is refused.
    const address = syntheticSlushSigner.toSuiAddress();
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await routes.challenge.POST(...request("challenge", { body: { address }, ip }))).status, 200);
    }
    const perAddress = await routes.challenge.POST(...request("challenge", { body: { address }, ip }));
    assert.ok(Number(perAddress.headers.get("retry-after")) >= 1);
    await refusal(perAddress, 429, "rate_limited");
    // Per IP, across addresses: 20 counted requests in all, then 429.
    for (let index = 0; index < 14; index += 1) {
      const wallet = new Ed25519Keypair().toSuiAddress();
      assert.equal((await routes.challenge.POST(...request("challenge", { body: { address: wallet }, ip }))).status, 200, String(index));
    }
    const perIp = await routes.challenge.POST(...request("challenge", { body: { address: new Ed25519Keypair().toSuiAddress() }, ip }));
    await refusal(perIp, 429, "rate_limited");
    // Another IP is unaffected.
    assert.equal((await signIn(new Ed25519Keypair())).status, 201);
  }));

test("OA-16: a wallet-only user creates an account (named by its callsign, not verified) and uses follows, settings and onboarding with the cookie", { skip }, () =>
  withDatabase(async (fixture) => {
    const { admin, signIn, social } = fixture;
    const signer = new Ed25519Keypair();
    const address = signer.toSuiAddress();
    const cookie = sessionCookieHeader(await signIn(signer));
    assert.deepEqual(await me(fixture, cookie), { account: null });

    const created = await social.accounts.create.POST(...api("/api/social/accounts", { method: "POST", body: { callsign: "Slush_Pilot" }, cookie }));
    const account = (await ok<{ account: NonNullable<SocialMeResponse["account"]> }>(created, 201, "me-response")).account;
    assert.equal(account.callsign, "slush_pilot");
    assert.equal(account.display_name, "slush_pilot", "no X: the callsign (OA-7)");
    assert.equal(account.x_handle, null, "not verified (OA-8)");
    assert.equal(account.kind, "new");
    assert.deepEqual(account.wallets.map((wallet) => [wallet.address, wallet.kind]), [[address, "slush"]]);
    const row = (await admin.query("SELECT privy_did, sui_address FROM social_accounts WHERE account_id = $1", [account.account_id])).rows[0];
    assert.deepEqual(row, { privy_did: null, sui_address: address });
    assert.deepEqual((await me(fixture, cookie)).account, account);
    await refused(
      await social.accounts.create.POST(...api("/api/social/accounts", { method: "POST", body: { callsign: "second_one" }, cookie })),
      409,
      "account_exists",
    );

    // Onboarding: shown, then complete as private.
    assert.equal((await social.onboarding.shown.POST(...api("/api/social/onboarding/shown", { method: "POST", cookie }))).status, 200);
    const completed = await social.onboarding.complete.POST(...api("/api/social/onboarding/complete", { method: "POST", body: { private: true }, cookie }));
    assert.equal(completed.status, 200);
    assert.equal((await me(fixture, cookie)).account?.privacy, "private");

    // Settings and follows.
    const saved = await social.settings.PUT(...api("/api/social/me/settings", { method: "PUT", body: { explorer: "suivision" }, cookie }));
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json()).explorer, "suivision");
    await admin.query("INSERT INTO social_accounts (account_id, privy_did, callsign, display_name) VALUES (gen_random_uuid(), 'did:privy:target', 'target_one', 'Target')");
    const followPath = "/api/social/follows/account/target_one";
    assert.equal((await social.follows.account.PUT(...api(followPath, { method: "PUT", cookie }))).status, 204);
    assert.equal(Number((await admin.query("SELECT count(*) AS n FROM social_follows WHERE follower_account_id = $1 AND source = 'user'", [account.account_id])).rows[0].n), 1);
    assert.equal((await social.follows.account.DELETE(...api(followPath, { method: "DELETE", cookie }))).status, 204);
    // A follow write without Origin is refused (CSRF), and changes nothing.
    await refused(await social.follows.account.PUT(...api(followPath, { method: "PUT", cookie, origin: null })), 403, "origin_invalid");
    assert.equal(Number((await admin.query("SELECT count(*) AS n FROM social_follows WHERE follower_account_id = $1 AND source = 'user'", [account.account_id])).rows[0].n), 0);
  }));

test("OA-16: an address linked to an account signs into it (member, linked social wallet); a Privy token wins over the cookie; an address two accounts hold is refused", { skip }, () =>
  withDatabase(async (fixture) => {
    const { admin, signIn, social } = fixture;
    // A Mission Control member's Slush wallet: the member's account (its social row is created on first use).
    const member = new Ed25519Keypair();
    const profileId = "00000000-0000-4000-8000-0000000000a1";
    await admin.query(
      `INSERT INTO mission_control_profiles (
         profile_id, privy_did, x_subject, x_handle, sui_address, provider_wallet_reference, callsign, display_name,
         disclosure_version, disclosure_accepted_at
       ) VALUES ($1, 'did:privy:member-a1', 'x-a1', 'member_x', $2, 'wallet-a1', 'member_one', 'Member One', 'fixture-v1', now())`,
      [profileId, member.toSuiAddress()],
    );
    await admin.query(
      `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, verified_at)
       VALUES (gen_random_uuid(), $1, 'slush', $2, 'ref-' || $2, now()) ON CONFLICT DO NOTHING`,
      [profileId, member.toSuiAddress()],
    );
    assert.equal((await admin.query("SELECT 1 FROM mission_control_account_wallets WHERE sui_address = $1", [member.toSuiAddress()])).rowCount, 1);
    const memberCookie = sessionCookieHeader(await signIn(member));
    const memberAccount = (await me(fixture, memberCookie)).account;
    assert.equal(memberAccount?.callsign, "member_one");
    assert.equal(memberAccount?.kind, "member");
    assert.equal(memberAccount?.x_handle, "member_x", "a member's X: verified");

    // A Privy account that linked a wallet (T-017): that account.
    const linked = new Ed25519Keypair();
    await social.accounts.create.POST(...api("/api/social/accounts", { method: "POST", body: { callsign: "privy_one" }, bearer: `privy:${PRIVY_DID}` }));
    const privyAccount = (await ok<SocialMeResponse>(await social.me.GET(...api("/api/social/me", { bearer: `privy:${PRIVY_DID}` })), 200, "me-response")).account!;
    await admin.query(
      "INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())",
      [linked.toSuiAddress(), privyAccount.account_id],
    );
    const linkedCookie = sessionCookieHeader(await signIn(linked));
    assert.equal((await me(fixture, linkedCookie)).account?.account_id, privyAccount.account_id);

    // Both sessions in one browser: the Privy token is the caller.
    const both = await ok<SocialMeResponse>(
      await social.me.GET(...api("/api/social/me", { cookie: memberCookie, bearer: `privy:${PRIVY_DID}` })),
      200,
      "me-response",
    );
    assert.equal(both.account?.account_id, privyAccount.account_id);

    // An address two different accounts hold (data from before the link guard): refused, not guessed.
    const contested = new Ed25519Keypair();
    const otherProfile = "00000000-0000-4000-8000-0000000000a2";
    await admin.query(
      `INSERT INTO mission_control_profiles (
         profile_id, privy_did, x_subject, x_handle, sui_address, provider_wallet_reference, callsign, display_name,
         disclosure_version, disclosure_accepted_at
       ) VALUES ($1, 'did:privy:member-a2', 'x-a2', 'member_two', $2, 'wallet-a2', 'member_two', 'Member Two', 'fixture-v1', now())`,
      [otherProfile, contested.toSuiAddress()],
    );
    await admin.query(
      `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, verified_at)
       VALUES (gen_random_uuid(), $1, 'slush', $2, 'ref-' || $2, now()) ON CONFLICT DO NOTHING`,
      [otherProfile, contested.toSuiAddress()],
    );
    assert.equal((await admin.query("SELECT 1 FROM mission_control_account_wallets WHERE sui_address = $1", [contested.toSuiAddress()])).rowCount, 1);
    await admin.query(
      "INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())",
      [contested.toSuiAddress(), privyAccount.account_id],
    );
    const contestedCookie = sessionCookieHeader(await signIn(contested));
    await refused(await social.me.GET(...api("/api/social/me", { cookie: contestedCookie })), 409, "wallet_ambiguous");
  }));
