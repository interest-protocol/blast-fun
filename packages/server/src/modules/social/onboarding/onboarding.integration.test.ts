import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import {
  SOCIAL_DEFAULT_ACCOUNT_COUNT,
  type SocialOnboardingCompleteResponse,
  type SocialOnboardingFollow,
  type SocialOnboardingShownResponse,
} from "@blast/core/modules/social/contracts/onboarding.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialOnboardingRoutes } from "@blast/server/modules/social/onboarding/routes.ts";
import { uuid } from "../../../../../core/test/kit.ts";

/**
 * Social-feed T-013 (AC-018, AC-019, AC-020, AC-030, AC-031/AC-032 at the
 * route, AC-126): `POST /api/social/onboarding/shown` and `/complete` over
 * migrations 0054–0056 as the web runtime role `blast_web`, with a real
 * Privy token verifier over a fixture ES256 key and the Postgres rate
 * limiter. Members join with `member`, `sticky`, `team` and `creator` codes
 * (Mission Control referrals); five new accounts are the defaults.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-onboarding-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-onboarding-fixture-pepper-0123456789";
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

const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** Mission Control members: the referrer (no social row yet) and recruits by code kind. */
const MEMBERS = {
  referrer: { n: 0x10, callsign: "ref_owner", displayName: "Ref Owner" },
  recruit: { n: 0x11, callsign: "recruit_m" },
  sticky: { n: 0x12, callsign: "recruit_s" },
  team: { n: 0x13, callsign: "recruit_t" },
  creator: { n: 0x14, callsign: "recruit_c" },
  plain: { n: 0x15, callsign: "plain_member" },
} as const;
type MemberName = keyof typeof MEMBERS;
const memberDid = (name: MemberName) => `did:privy:onboarding-${name}`;
const profileId = (name: MemberName) => uuid(MEMBERS[name].n);

/** The default accounts (new accounts), in position order. */
const DEFAULTS = Array.from({ length: SOCIAL_DEFAULT_ACCOUNT_COUNT }, (_, offset) => offset + 1).map((index) => ({
  id: uuid(0xd0 + index),
  did: `did:privy:onboarding-default-${index}`,
  callsign: `default_${index}`,
  displayName: `Default ${index}`,
  avatar: index === 1 ? "https://pbs.twimg.com/default-1.png" : null,
}));
const NEW_ACCOUNT = { id: uuid(0xe1), did: "did:privy:onboarding-new", callsign: "new_person" };
const NOBODY_DID = "did:privy:onboarding-nobody";

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function post(path: "shown" | "complete", did: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (did) headers.authorization = `Bearer ${token(did)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}/api/social/onboarding/${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Routes = ReturnType<typeof createSocialOnboardingRoutes>;
type Fixture = Readonly<{
  admin: Pool;
  routes: Routes;
  me(did: string): Promise<SocialMeResponse>;
}>;

async function insertMember(db: Pool, name: MemberName): Promise<void> {
  const member = MEMBERS[name];
  const id = profileId(name);
  const xSubject = `x-onboarding-${name}`;
  await db.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, sui_address, provider_wallet_reference, callsign,
       display_name, disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fixture-v1', now())`,
    [id, memberDid(name), xSubject, member.callsign, wallet(0x9000 + member.n), `wallet-${name}`, member.callsign,
      "displayName" in member ? member.displayName : null],
  );
  await db.query(
    `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
     VALUES ($1, 'privy', $2, now()), ($1, 'x', $3, now())`,
    [id, memberDid(name), xSubject],
  );
}

let codeSequence = 0;
async function insertCode(db: Pool, kind: "member" | "sticky" | "team" | "creator", extra: {
  owner?: string;
  seedCreator?: string;
  sticky?: number;
}): Promise<string> {
  codeSequence += 1;
  const codeId = randomUUID();
  await db.query(
    `INSERT INTO mission_control_invitation_codes (
       code_id, season_id, lookup_key_version, lookup_hmac, encrypted_display, encryption_iv, encryption_tag,
       encryption_key_version, enabled, code_kind, owner_profile_id, seed_creator_id, seed_code_group_id, sticky_position
     ) VALUES ($1, 'season-zero', 'test-v1', $2, 'source', 'aXY=', 'dGFn', 'test-v1', TRUE, $3, $4, $5, $5, $6)`,
    [codeId, createHash("sha256").update(`onboarding-code-${codeSequence}`).digest("hex"), kind, extra.owner ?? null,
      extra.seedCreator ?? null, extra.sticky ?? null],
  );
  return codeId;
}

async function insertReferral(db: Pool, recruit: MemberName, referrer: MemberName, codeId: string): Promise<void> {
  await db.query(
    `INSERT INTO mission_control_referrals (recruited_profile_id, referrer_profile_id, source_code_id, created_at)
     VALUES ($1, $2, $3, now())`,
    [profileId(recruit), profileId(referrer), codeId],
  );
}

/** Configures `count` of the defaults, positions 1.. in order. */
async function configureDefaults(db: Pool, count: number): Promise<void> {
  await db.query("DELETE FROM social_default_accounts");
  for (const [index, account] of DEFAULTS.slice(0, count).entries()) {
    await db.query("INSERT INTO social_default_accounts (position, account_id) VALUES ($1, $2)", [index + 1, account.id]);
  }
}

async function seed(db: Pool): Promise<void> {
  for (const name of Object.keys(MEMBERS) as MemberName[]) await insertMember(db, name);
  for (const account of [...DEFAULTS, { ...NEW_ACCOUNT, displayName: null, avatar: null }]) {
    await db.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_avatar_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [account.id, account.did, account.callsign, account.displayName, account.avatar],
    );
  }
  // The recruit joined with the referrer's member code.
  await insertReferral(db, "recruit", "referrer", await insertCode(db, "member", { owner: profileId("referrer") }));
  // Sticky, team and creator codes carry no member owner: a referral row through one makes no follow.
  await insertReferral(db, "sticky", "referrer", await insertCode(db, "sticky", { sticky: 1 }));
  await insertReferral(db, "team", "referrer", await insertCode(db, "team", {}));
  const seedCreator = randomUUID();
  await db.query(
    `INSERT INTO mission_control_seed_creators (seed_creator_id, season_id, display_name, expected_x_handle)
     VALUES ($1, 'season-zero', 'Seed Creator', 'seed_creator')`,
    [seedCreator],
  );
  await db.query(
    `INSERT INTO mission_control_seed_code_groups (seed_code_group_id, seed_creator_id, group_label)
     VALUES ($1, $1, 'Seed Creator')`,
    [seedCreator],
  );
  await insertReferral(db, "creator", "referrer", await insertCode(db, "creator", { seedCreator }));
  await configureDefaults(db, SOCIAL_DEFAULT_ACCOUNT_COUNT);
}

async function withDatabase(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL_SETTINGS, "social-onboarding-test");
  try {
    await seed(admin);
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => web,
    });
    const meRoute = createSocialMeRoute({ kit, accounts });
    await run({
      admin,
      routes: createSocialOnboardingRoutes({ kit }),
      async me(did) {
        const response = await meRoute.GET(new Request(`${ORIGIN}/api/social/me`, {
          headers: { authorization: `Bearer ${token(did)}` },
        }), testClient());
        assert.equal(response.status, 200);
        return (await response.json()) as SocialMeResponse;
      },
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

async function ok<Body>(response: Response, schema: "onboarding-shown-response" | "onboarding-complete-response"): Promise<Body> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as Body;
}

async function shownFollows(routes: Routes, did: string): Promise<readonly SocialOnboardingFollow[]> {
  return (await ok<SocialOnboardingShownResponse>(await routes.shown.POST(post("shown", did), testClient()), "onboarding-shown-response")).follows;
}

async function refusal(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}

type FollowRow = { target_id: string; source: string; created_at: string };

async function followsOf(db: Pool, accountId: string): Promise<FollowRow[]> {
  return (await db.query<FollowRow>(
    `SELECT target_id, source, created_at::text FROM social_follows
     WHERE follower_account_id = $1 ORDER BY target_id`,
    [accountId],
  )).rows;
}

type AccountRow = {
  account_id: string;
  onboarding_shown_at: string | null;
  onboarded_at: string | null;
  default_follows_applied_at: string | null;
  launch_code_follow_applied_at: string | null;
  privacy: string;
  sharing_since: string | null;
};

async function accountOf(db: Pool, where: { profile: string } | { id: string }): Promise<AccountRow | undefined> {
  const [column, value] = "profile" in where ? ["profile_id", where.profile] : ["account_id", where.id];
  return (await db.query<AccountRow>(
    `SELECT account_id, onboarding_shown_at::text, onboarded_at::text, default_follows_applied_at::text,
       launch_code_follow_applied_at::text, privacy, sharing_since::text
     FROM social_accounts WHERE ${column} = $1`,
    [value],
  )).rows[0];
}

const defaultFollows = (accounts = DEFAULTS) =>
  accounts.map((account) => ({
    account_id: account.id,
    callsign: account.callsign,
    display_name: account.displayName,
    avatar_url: account.avatar,
    x_handle: null,
    source: "default" as const,
  }));

test("T-013-AC-1 (AC-018, AC-019): shown applies 5 default and 1 launch-code follow once, in one transaction, and returns them", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    assert.equal(await accountOf(admin, { profile: profileId("referrer") }), undefined, "the referrer has no social row yet");

    // One transaction: a failure at the last write (the markers) leaves no follow and no marker behind.
    await admin.query(`
      CREATE FUNCTION onboarding_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected'; END $$`);
    await admin.query(`
      CREATE TRIGGER onboarding_test_fail BEFORE UPDATE OF onboarding_shown_at ON social_accounts
      FOR EACH ROW EXECUTE FUNCTION onboarding_test_fail()`);
    await refusal(await routes.shown.POST(post("shown", memberDid("recruit")), testClient()), 503, "service_unavailable");
    const recruitAfterFailure = await accountOf(admin, { profile: profileId("recruit") });
    assert.ok(recruitAfterFailure, "account resolution created the recruit's row");
    assert.deepEqual(await followsOf(admin, recruitAfterFailure.account_id), []);
    assert.equal(recruitAfterFailure.onboarding_shown_at, null);
    assert.equal(recruitAfterFailure.default_follows_applied_at, null);
    assert.equal(recruitAfterFailure.launch_code_follow_applied_at, null);
    assert.equal(await accountOf(admin, { profile: profileId("referrer") }), undefined, "the referrer row rolled back too");
    await admin.query("DROP TRIGGER onboarding_test_fail ON social_accounts");
    await admin.query("DROP FUNCTION onboarding_test_fail()");

    // Concurrent first calls apply the follows exactly once and all answer the same list.
    const lists = await Promise.all(Array.from({ length: 4 }, () => shownFollows(routes, memberDid("recruit"))));
    const referrer = await accountOf(admin, { profile: profileId("referrer") });
    assert.ok(referrer, "the referrer's social row is created as resolution would create it");
    const expected = [
      { account_id: referrer.account_id, callsign: "ref_owner", display_name: "Ref Owner", avatar_url: null, x_handle: "ref_owner", source: "launch_code" },
      ...defaultFollows(),
    ];
    for (const list of lists) assert.deepEqual(list, expected);

    const recruit = (await accountOf(admin, { profile: profileId("recruit") }))!;
    const rows = await followsOf(admin, recruit.account_id);
    assert.equal(rows.length, SOCIAL_DEFAULT_ACCOUNT_COUNT + 1);
    assert.deepEqual(rows.filter((row) => row.source === "launch_code").map((row) => row.target_id), [referrer.account_id]);
    assert.deepEqual(
      rows.filter((row) => row.source === "default").map((row) => row.target_id).sort(),
      DEFAULTS.map((account) => account.id).sort(),
    );
    assert.ok(recruit.onboarding_shown_at && recruit.default_follows_applied_at && recruit.launch_code_follow_applied_at);
    assert.equal(recruit.onboarded_at, null);

    // A repeat call writes nothing and answers the same list.
    const before = { follows: rows, account: recruit };
    assert.deepEqual(await shownFollows(routes, memberDid("recruit")), expected);
    assert.deepEqual({ follows: await followsOf(admin, recruit.account_id), account: await accountOf(admin, { id: recruit.account_id }) }, before);
  }));

test("T-013-AC-2 (AC-030): a removed launch-code or default follow is never re-added", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    await shownFollows(routes, memberDid("recruit"));
    const recruit = (await accountOf(admin, { profile: profileId("recruit") }))!;
    // The recruit unfollows the referrer and one default (as the follow route will).
    await admin.query("DELETE FROM social_follows WHERE follower_account_id = $1 AND source = 'launch_code'", [recruit.account_id]);
    await admin.query("DELETE FROM social_follows WHERE follower_account_id = $1 AND target_id = $2", [recruit.account_id, DEFAULTS[2]!.id]);

    const expected = defaultFollows().filter((follow) => follow.account_id !== DEFAULTS[2]!.id);
    assert.deepEqual(await shownFollows(routes, memberDid("recruit")), expected);
    // Completing (which also runs the shown step when needed) does not re-add them either.
    await ok(await routes.complete.POST(post("complete", memberDid("recruit"), { private: false }), testClient()), "onboarding-complete-response");
    assert.equal((await followsOf(admin, recruit.account_id)).length, SOCIAL_DEFAULT_ACCOUNT_COUNT - 1);
    assert.deepEqual(await shownFollows(routes, memberDid("recruit")), expected);
  }));

test("T-013-AC-3 (AC-020): complete stores the choice; public starts sharing at the server's time, private shares nothing", { skip }, () =>
  withDatabase(async ({ admin, routes, me }) => {
    // Public, after shown.
    await shownFollows(routes, memberDid("recruit"));
    const started = Date.now();
    const done = await ok<SocialOnboardingCompleteResponse>(
      await routes.complete.POST(post("complete", memberDid("recruit"), { private: false }), testClient()),
      "onboarding-complete-response",
    );
    const ended = Date.now();
    assert.equal(done.privacy, "public");
    assert.deepEqual(done.onboarding, { shown: true, completed: true });
    assert.ok(done.sharing_since_ms !== null && done.sharing_since_ms >= started - 1_000 && done.sharing_since_ms <= ended + 1_000);
    const recruit = (await accountOf(admin, { profile: profileId("recruit") }))!;
    assert.ok(recruit.onboarded_at);
    assert.equal(recruit.privacy, "public");
    assert.equal(recruit.sharing_since, recruit.onboarded_at, "sharing starts when onboarding completes");
    const meRecruit = (await me(memberDid("recruit"))).account!;
    assert.deepEqual(meRecruit.onboarding, { shown: true, completed: true });
    assert.equal(meRecruit.sharing_since_ms, done.sharing_since_ms);

    // Already onboarded: the current state comes back and nothing changes.
    const again = await ok<SocialOnboardingCompleteResponse>(
      await routes.complete.POST(post("complete", memberDid("recruit"), { private: true }), testClient()),
      "onboarding-complete-response",
    );
    assert.deepEqual(again, done);
    assert.deepEqual(await accountOf(admin, { id: recruit.account_id }), recruit);

    // Private, never shown: complete applies the shown step first in the same transaction.
    const done2 = await ok<SocialOnboardingCompleteResponse>(
      await routes.complete.POST(post("complete", memberDid("plain"), { private: true }), testClient()),
      "onboarding-complete-response",
    );
    assert.deepEqual(done2, { onboarding: { shown: true, completed: true }, privacy: "private", sharing_since_ms: null });
    const plain = (await accountOf(admin, { profile: profileId("plain") }))!;
    assert.ok(plain.onboarded_at && plain.onboarding_shown_at && plain.default_follows_applied_at && plain.launch_code_follow_applied_at);
    assert.equal(plain.privacy, "private");
    assert.equal(plain.sharing_since, null);
    assert.equal((await followsOf(admin, plain.account_id)).length, SOCIAL_DEFAULT_ACCOUNT_COUNT);
    assert.deepEqual((await me(memberDid("plain"))).account!.onboarding, { shown: true, completed: true });
  }));

test("T-013-AC-4 (AC-032, REQ-006): fewer than five defaults apply as configured; sticky, team and creator codes and new accounts get no launch-code follow; nobody follows themself", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    await configureDefaults(admin, 3);
    for (const name of ["sticky", "team", "creator"] as const) {
      assert.deepEqual(await shownFollows(routes, memberDid(name)), defaultFollows(DEFAULTS.slice(0, 3)), name);
    }
    assert.deepEqual(await shownFollows(routes, NEW_ACCOUNT.did), defaultFollows(DEFAULTS.slice(0, 3)));
    const fresh = (await accountOf(admin, { id: NEW_ACCOUNT.id }))!;
    assert.ok(fresh.launch_code_follow_applied_at, "the marker is set even with nothing to apply");
    // A default account onboarding skips itself.
    assert.deepEqual(await shownFollows(routes, DEFAULTS[0]!.did), defaultFollows(DEFAULTS.slice(1, 3)));

    // A later change of the defaults applies only to accounts whose onboarding starts after it.
    await configureDefaults(admin, SOCIAL_DEFAULT_ACCOUNT_COUNT);
    assert.deepEqual(await shownFollows(routes, NEW_ACCOUNT.did), defaultFollows(DEFAULTS.slice(0, 3)));
    assert.deepEqual(await shownFollows(routes, memberDid("recruit")), [
      launchCodeFollow(await accountOf(admin, { profile: profileId("referrer") })),
      ...defaultFollows(),
    ]);
  }));

function launchCodeFollow(referrer: AccountRow | undefined) {
  assert.ok(referrer);
  return { account_id: referrer.account_id, callsign: "ref_owner", display_name: "Ref Owner", avatar_url: null, x_handle: "ref_owner", source: "launch_code" as const };
}

test("T-013 refusals: no token, no account, a body on shown, an open or mistyped complete body", { skip }, () =>
  withDatabase(async ({ routes }) => {
    await refusal(await routes.shown.POST(post("shown", null), testClient()), 401, "unauthorized");
    await refusal(await routes.complete.POST(post("complete", null, { private: false }), testClient()), 401, "unauthorized");
    await refusal(await routes.shown.POST(post("shown", NOBODY_DID), testClient()), 409, "account_required");
    await refusal(await routes.complete.POST(post("complete", NOBODY_DID, { private: false }), testClient()), 409, "account_required");
    await refusal(await routes.shown.POST(post("shown", NEW_ACCOUNT.did, {}), testClient()), 400, "invalid_request");
    await refusal(await routes.complete.POST(post("complete", NEW_ACCOUNT.did, {}), testClient()), 400, "invalid_request");
    await refusal(await routes.complete.POST(post("complete", NEW_ACCOUNT.did, { private: "yes" }), testClient()), 400, "invalid_request");
    await refusal(await routes.complete.POST(post("complete", NEW_ACCOUNT.did, { private: true, extra: 1 }), testClient()), 400, "invalid_request");
    await refusal(await routes.complete.POST(post("complete", NEW_ACCOUNT.did, "{"), testClient()), 400, "invalid_request");
  }));

test("T-013-AC-7 (AC-126): social_account_update allows 30 per 10 minutes per account across both routes, then 429 with Retry-After", { skip }, () =>
  withDatabase(async ({ routes }) => {
    for (let index = 0; index < 30; index += 1) {
      assert.equal((await routes.shown.POST(post("shown", memberDid("team")), testClient())).status, 200);
    }
    for (const response of [
      await routes.shown.POST(post("shown", memberDid("team")), testClient()),
      await routes.complete.POST(post("complete", memberDid("team"), { private: false }), testClient()),
    ]) {
      await refusal(response.clone(), 429, "rate_limited");
      const retryAfter = Number(response.headers.get("retry-after"));
      assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 600, String(retryAfter));
    }

    for (let index = 0; index < 30; index += 1) {
      assert.equal((await routes.complete.POST(post("complete", memberDid("sticky"), { private: true }), testClient())).status, 200);
    }
    const limited = await routes.complete.POST(post("complete", memberDid("sticky"), { private: true }), testClient());
    await refusal(limited.clone(), 429, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  }));
