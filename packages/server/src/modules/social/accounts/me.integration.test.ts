import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialXHandleRoute } from "@blast/server/modules/social/accounts/x-handle-route.ts";

/**
 * Social-feed T-002 (AC-001..AC-004, AC-014, AC-124, AC-130): `GET
 * /api/social/me` over migrations 0054/0055 as the web runtime role
 * `blast_web`, with a real Privy token verifier over a fixture ES256 key (no
 * provider call). Seeds a Mission Control member, a new account and a user
 * with neither.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-me-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-me-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 2_000,
  max: 12,
  statementTimeoutMs: 5_000,
};

const MEMBER_DID = "did:privy:social-me-member";
const MEMBER_X_SUBJECT = "x-subject-social-me-member";
const RACER_DID = "did:privy:social-me-racer";
const NEW_DID = "did:privy:social-me-new";
const NEW_X_SUBJECT = "x-subject-social-me-new";
const NOBODY_DID = "did:privy:social-me-nobody";

const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const W = {
  memberEmbedded: wallet(0xe1),
  memberSlush: wallet(0x51),
  memberExternal: wallet(0xa1),
  newEmbedded: wallet(0xe2),
  newSlush: wallet(0x52),
};
const ms = (iso: string) => Date.parse(iso);

function token(did: string, claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did, ...claims });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const get = (authorization?: string) =>
  new Request(`${ORIGIN}/api/social/me`, { headers: authorization ? { authorization } : {} });
const bearer = (did: string, claims?: Record<string, unknown>) => `Bearer ${token(did, claims)}`;

/**
 * `pool`, except that each `INSERT INTO social_accounts` waits until `parties`
 * of them are pending: every racer has read "no row" before any inserts, so
 * the race is real rather than left to scheduling.
 */
function insertBarrier(pool: Pool, parties: number): Pool {
  let pending = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const bound = <T extends object>(target: T, property: PropertyKey) => {
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property !== "connect") return bound(target, property);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, name) {
            if (name !== "query") return bound(inner, name);
            return async (config: string | { text: string }, values?: unknown[]) => {
              const text = typeof config === "string" ? config : config.text;
              if (text.startsWith("INSERT INTO social_accounts")) {
                pending += 1;
                if (pending === parties) open();
                await gate;
              }
              return (inner.query as (config: unknown, values?: unknown[]) => Promise<unknown>)(config, values);
            };
          },
        });
      };
    },
  });
}

function meRoute(web: Pool, accountsPool: Pool = web) {
  const accounts = new PostgresSocialAccounts(() => accountsPool);
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
    accounts,
    primary: () => web,
  });
  return createSocialMeRoute({ kit, accounts });
}

/** A 200 `me` body, checked against the published schema and the private, no-store headers. */
async function meBody(response: Response): Promise<SocialMeResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("me-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialMeResponse;
}

async function insertMember(db: Pool, n: number, did: string, xSubject: string, callsign: string, extra: {
  displayName?: string;
  avatar?: string;
  xAvatar?: string;
  xHandle?: string;
} = {}): Promise<string> {
  const profileId = `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  await db.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, x_avatar_reference, sui_address, provider_wallet_reference, callsign,
       display_name, avatar_reference, disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'fixture-v1', now())`,
    [profileId, did, xSubject, extra.xHandle ?? null, extra.xAvatar ?? null, wallet(0x9000 + n), `wallet-${n}`, callsign,
      extra.displayName ?? null, extra.avatar ?? null],
  );
  await db.query(
    `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
     VALUES ($1, 'privy', $2, now()), ($1, 'x', $3, now())`,
    [profileId, did, xSubject],
  );
  return profileId;
}

async function withDatabase(run: (pools: { admin: Pool; web: Pool }) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL_SETTINGS, "social-me-test");
  try {
    await run({ admin, web });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

/** Seeds the member (no account row yet), the new account with its wallets, and the member's linked wallets. */
async function seed(admin: Pool): Promise<{ memberProfileId: string; newAccountId: string }> {
  const memberProfileId = await insertMember(admin, 1, MEMBER_DID, MEMBER_X_SUBJECT, "pilot_one", {
    displayName: "Pilot One",
    avatar: "https://cdn.blast.fun/avatars/pilot-one.png",
    xAvatar: "https://pbs.twimg.com/pilot-one.png",
    xHandle: "pilotone",
  });
  await admin.query(
    `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, is_primary, verified_at)
     VALUES ('00000000-0000-4000-8000-0000000000e1', $1, 'embedded', $2, 'ref-e1', true, '2026-01-02T00:00:00Z'),
            ('00000000-0000-4000-8000-000000000051', $1, 'slush', $3, 'ref-51', false, '2026-01-03T00:00:00Z')`,
    [memberProfileId, W.memberEmbedded, W.memberSlush],
  );
  // The presale cached the member's embedded wallet earlier than Mission Control verified it: the earliest link wins.
  await admin.query(
    `INSERT INTO presale_embedded_wallets (privy_did, address, resolved_at)
     VALUES ($1, $2, '2026-01-01T00:00:00Z'), ($3, $4, '2026-02-01T00:00:00Z')`,
    [MEMBER_DID, W.memberEmbedded, NEW_DID, W.newEmbedded],
  );
  const newAccountId = "00000000-0000-4000-8000-00000000a002";
  await admin.query(
    `INSERT INTO social_accounts (
       account_id, privy_did, callsign, display_name, x_subject, x_handle, x_avatar_url,
       onboarding_shown_at, privacy, sharing_since
     ) VALUES ($1, $2, 'new_pilot', 'New Pilot', $3, 'newpilot', 'https://pbs.twimg.com/new-pilot.png',
       now(), 'public', '2026-02-03T00:00:00.123Z')`,
    [newAccountId, NEW_DID, NEW_X_SUBJECT],
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, kind, verified_at)
     VALUES ($1, $3, 'slush', '2026-02-02T00:00:00Z'),
            -- The member's Mission Control slush wallet, also proven by the new account: two owners, so neither lists it.
            ($2, $3, 'external', '2026-02-04T00:00:00Z')`,
    [W.newSlush, W.memberSlush, newAccountId],
  );
  return { memberProfileId, newAccountId };
}

test("Privy login refreshes the existing X handle for members and new accounts without changing their identity", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const { memberProfileId, newAccountId } = await seed(admin);
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => web,
    });
    let mode = "renamed";
    let providerCalls = 0;
    const refresh = createSocialXHandleRoute({ kit, primary: () => web, privyUsers: () => ({
      async getUser(did) {
        providerCalls += 1;
        if (mode === "unavailable") throw new Error("provider unavailable");
        return { id: did, linked_accounts: mode === "unlinked" ? [] : [{
          type: "twitter_oauth",
          subject: mode === "different-account" ? "someone-else" : did === MEMBER_DID ? MEMBER_X_SUBJECT : NEW_X_SUBJECT,
          username: mode === "invalid-handle" ? "bad handle!" : did === MEMBER_DID ? "renamed_member" : "renamed_pilot",
          name: "Changed X name",
          profile_picture_url: "https://pbs.twimg.com/changed.png",
        }] };
      },
    }) });
    const post = (did: string, origin = ORIGIN) => new Request(`${ORIGIN}/api/social/me/x-handle`, {
      method: "POST", headers: { authorization: bearer(did), origin },
    });
    const me = meRoute(web);
    const beforeMember = (await meBody(await me.GET(get(bearer(MEMBER_DID)), testClient()))).account!;
    const beforeNew = (await meBody(await me.GET(get(bearer(NEW_DID)), testClient()))).account!;
    for (const did of [MEMBER_DID, NEW_DID]) {
      const response = await refresh(post(did), testClient());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await response.json(), { updated: true });
      assert.deepEqual(await (await refresh(post(did), testClient())).json(), { updated: false }, "an unchanged handle is not rewritten");
    }
    assert.deepEqual((await meBody(await me.GET(get(bearer(MEMBER_DID)), testClient()))).account, { ...beforeMember, x_handle: "renamed_member" });
    assert.deepEqual((await meBody(await me.GET(get(bearer(NEW_DID)), testClient()))).account, { ...beforeNew, x_handle: "renamed_pilot" });
    const publicIdentity = await admin.query("SELECT x_handle FROM social_account_identities WHERE account_id = $1", [beforeMember.account_id]);
    assert.equal(publicIdentity.rows[0]?.x_handle, "renamed_member");

    for (mode of ["different-account", "invalid-handle", "unlinked", "unavailable"]) {
      for (const did of [MEMBER_DID, NEW_DID]) {
        assert.deepEqual(await (await refresh(post(did), testClient())).json(), { updated: false }, mode);
      }
    }
    assert.equal((await admin.query("SELECT x_subject, x_handle FROM mission_control_profiles WHERE profile_id = $1", [memberProfileId])).rows[0]?.x_subject, MEMBER_X_SUBJECT);
    assert.equal((await admin.query("SELECT x_subject, x_handle FROM social_accounts WHERE account_id = $1", [newAccountId])).rows[0]?.x_handle, "renamed_pilot");
    assert.equal((await meBody(await me.GET(get(bearer(MEMBER_DID)), testClient()))).account?.x_handle, "renamed_member");
    const calls = providerCalls;
    assert.deepEqual(await (await refresh(post(NOBODY_DID), testClient())).json(), { updated: false });
    assert.equal((await refresh(new Request(`${ORIGIN}/api/social/me/x-handle`, { method: "POST" }), testClient())).status, 401);
    assert.equal((await refresh(post(MEMBER_DID, "https://evil.example"), testClient())).status, 403);
    assert.equal(providerCalls, calls, "missing accounts and refused requests never call Privy");
  }));

test("T-002-AC-1, AC-2, AC-4, AC-5, AC-6: member, new account and no account resolve with their wallets", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const { memberProfileId, newAccountId } = await seed(admin);
    const route = meRoute(web);

    // AC-4: the member has no social row until its first resolution.
    assert.equal((await admin.query("SELECT 1 FROM social_accounts WHERE profile_id = $1", [memberProfileId])).rowCount, 0);
    const first = await meBody(await route.GET(get(bearer(MEMBER_DID)), testClient()));
    const rows = await admin.query<{ account_id: string; onboarded_at: Date | null; privy_did: string | null; callsign: string | null }>(
      "SELECT account_id, onboarded_at, privy_did, callsign FROM social_accounts WHERE profile_id = $1",
      [memberProfileId],
    );
    assert.equal(rows.rowCount, 1);
    assert.deepEqual(rows.rows[0], { account_id: first.account?.account_id, onboarded_at: null, privy_did: null, callsign: null });
    const memberAccountId = rows.rows[0]!.account_id;

    // A wallet the member's account proved itself.
    await admin.query(
      "INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, '2026-01-04T00:00:00Z')",
      [W.memberExternal, memberAccountId],
    );

    // AC-1 and AC-5: the member's Mission Control identity, and each wallet with its kind and earliest link.
    const member = await meBody(await route.GET(get(bearer(MEMBER_DID)), testClient()));
    assert.deepEqual(member, {
      account: {
        account_id: memberAccountId,
        kind: "member",
        callsign: "pilot_one",
        display_name: "Pilot One",
        avatar_url: "https://cdn.blast.fun/avatars/pilot-one.png",
        x_handle: "pilotone",
        // OA-8: a member signed up with X.
        verified: true,
        onboarding: { shown: false, completed: false },
        privacy: "public",
        sharing_since_ms: null,
        wallets: [
          { address: W.memberEmbedded, kind: "embedded", linked_at_ms: ms("2026-01-01T00:00:00Z") },
          { address: W.memberExternal, kind: "external", linked_at_ms: ms("2026-01-04T00:00:00Z") },
        ],
      },
    });
    // A second call creates nothing.
    assert.equal((await admin.query("SELECT 1 FROM social_accounts WHERE profile_id IS NOT NULL")).rowCount, 1);

    // The new account: its own callsign and X identity; the shared slush address is omitted.
    assert.deepEqual(await meBody(await route.GET(get(bearer(NEW_DID)), testClient())), {
      account: {
        account_id: newAccountId,
        kind: "new",
        callsign: "new_pilot",
        display_name: "New Pilot",
        avatar_url: "https://pbs.twimg.com/new-pilot.png",
        x_handle: "newpilot",
        // OA-8: its own X subject is set.
        verified: true,
        onboarding: { shown: true, completed: false },
        privacy: "public",
        sharing_since_ms: ms("2026-02-03T00:00:00.123Z"),
        wallets: [
          { address: W.newEmbedded, kind: "embedded", linked_at_ms: ms("2026-02-01T00:00:00Z") },
          { address: W.newSlush, kind: "slush", linked_at_ms: ms("2026-02-02T00:00:00Z") },
        ],
      },
    });

    // AC-2: a Privy user with neither gets account null, and nothing is created.
    assert.deepEqual(await meBody(await route.GET(get(bearer(NOBODY_DID)), testClient())), { account: null });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_accounts")).rows[0].n, 2);

    // A member whose profile has no avatar of its own shows its X avatar.
    await admin.query("UPDATE mission_control_profiles SET avatar_reference = NULL WHERE profile_id = $1", [memberProfileId]);
    assert.equal((await meBody(await route.GET(get(bearer(MEMBER_DID)), testClient()))).account?.avatar_url, "https://pbs.twimg.com/pilot-one.png");

    // A private account that has onboarded.
    await admin.query(
      "UPDATE social_accounts SET privacy = 'private', sharing_since = NULL, onboarded_at = now() WHERE account_id = $1",
      [newAccountId],
    );
    const updated = (await meBody(await route.GET(get(bearer(NEW_DID)), testClient()))).account;
    assert.equal(updated?.privacy, "private");
    assert.equal(updated?.sharing_since_ms, null);
    assert.deepEqual(updated?.onboarding, { shown: true, completed: true });
  }));

test("member identity takes precedence over a standalone account with the same DID", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const { memberProfileId } = await seed(admin);
    await admin.query(
      "INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES (gen_random_uuid(), $1, 'shadow_account')",
      [MEMBER_DID],
    );
    const accounts = new PostgresSocialAccounts(() => web);
    const member = await accounts.resolve(MEMBER_DID);
    assert.equal(member?.kind, "member");
    assert.equal(member?.account_id, (await admin.query("SELECT account_id FROM social_accounts WHERE profile_id=$1", [memberProfileId])).rows[0].account_id);
    assert.notEqual(member?.callsign, "shadow_account");
    assert.equal((await accounts.resolve(NEW_DID))?.kind, "new");
    assert.equal(await accounts.resolve(NOBODY_DID), null);
  }),
);

test("T-002-AC-3, AC-6: a missing, malformed or expired token is 401 with the error body and no account data", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    await seed(admin);
    const route = meRoute(web);
    for (const authorization of [
      undefined,
      "Bearer",
      "Bearer not.a.jwt",
      `Token ${token(MEMBER_DID)}`,
      bearer(MEMBER_DID, { exp: NOW - 30, iat: NOW - 3_600 }),
      bearer(MEMBER_DID, { aud: "someone-else" }),
    ]) {
      const response = await route.GET(get(authorization), testClient());
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 401, String(authorization));
      assert.deepEqual(body, { error: { code: "unauthorized", message: "Sign in to continue." } });
      assert.deepEqual(validator.validate("error", body).errors, []);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(response.headers.get("x-request-id"));
    }
    // A refused token never creates the member's row.
    assert.equal((await admin.query("SELECT 1 FROM social_accounts WHERE profile_id IS NOT NULL")).rowCount, 0);
  }));

test("T-002-AC-4: ten concurrent first calls of a member create exactly one row", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    const profileId = await insertMember(admin, 7, RACER_DID, "x-subject-racer", "racer_pilot");
    const route = meRoute(web, insertBarrier(web, 10));
    const authorization = bearer(RACER_DID);
    const bodies = await Promise.all(Array.from({ length: 10 }, async () => meBody(await route.GET(get(authorization), testClient()))));
    const rows = await admin.query<{ account_id: string; onboarded_at: Date | null }>(
      "SELECT account_id, onboarded_at FROM social_accounts WHERE profile_id = $1",
      [profileId],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]!.onboarded_at, null);
    assert.deepEqual(new Set(bodies.map((body) => body.account?.account_id)), new Set([rows.rows[0]!.account_id]));
    assert.ok(bodies.every((body) => body.account?.kind === "member" && body.account.callsign === "racer_pilot"));
  }));

test("T-002-AC-7: log lines during a 401 and a 200 carry no bearer token, Privy DID or X subject", { skip }, () =>
  withDatabase(async ({ admin, web }) => {
    await seed(admin);
    const route = meRoute(web);
    const previousMetrics = process.env.MISSION_CONTROL_METRICS;
    process.env.MISSION_CONTROL_METRICS = "on";
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown) => lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    for (const name of methods) {
      console[name] = (...args: unknown[]) => capture(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }
    process.stdout.write = ((chunk: unknown) => (capture(chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (capture(chunk), true)) as typeof process.stderr.write;
    const secrets = [token(MEMBER_DID), token(NEW_DID)];
    let responses: Response[];
    try {
      responses = [
        await route.GET(get(`Bearer ${secrets[0]}x`), testClient()), // a bad signature: 401
        await route.GET(get(`Bearer ${secrets[0]}`), testClient()), // the member's first call: 200, creates its row
        await route.GET(get(`Bearer ${secrets[1]}`), testClient()), // the new account: 200
      ];
    } finally {
      methods.forEach((name, index) => (console[name] = originals[index]!));
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      if (previousMetrics === undefined) delete process.env.MISSION_CONTROL_METRICS;
      else process.env.MISSION_CONTROL_METRICS = previousMetrics;
    }
    assert.deepEqual(responses.map((response) => response.status), [401, 200, 200]);
    // Metrics were on, so the reads did log: the check is not vacuous.
    assert.ok(lines.some((line) => line.includes('"social.account_with_wallets"')), lines.join("\n"));
    const forbidden = [...secrets, ...secrets.map((secret) => secret.split(".")[1]!), MEMBER_DID, NEW_DID, MEMBER_X_SUBJECT, NEW_X_SUBJECT, "did:privy:"];
    for (const line of lines) {
      for (const value of forbidden) assert.ok(!line.includes(value), `a log line carries a secret: ${line}`);
    }
    // Nor does any response body.
    for (const response of responses) {
      const text = await response.text();
      for (const value of [MEMBER_DID, NEW_DID, MEMBER_X_SUBJECT, NEW_X_SUBJECT, "did:privy:"]) assert.ok(!text.includes(value), text);
    }
  }));
