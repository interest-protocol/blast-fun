import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import type { SocialCallsignAvailability, SocialCreateAccountResponse } from "@blast/core/modules/social/contracts/accounts.ts";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import type { SocialOnboardingShownResponse } from "@blast/core/modules/social/contracts/onboarding.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialOnboardingRoutes } from "@blast/server/modules/social/onboarding/routes.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialAccountCreationRoutes } from "@blast/server/modules/social/accounts/creation-routes.ts";
import { REFERRAL_COOKIE } from "@blast/core/modules/social/referrals/contracts.ts";
import { createReferralInviteesRoute, createReferralRoute } from "@blast/server/modules/social/referrals/route.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { uuid } from "../../../../../core/test/kit.ts";

/**
 * Social-feed T-014 (AC-005, AC-006, AC-007, AC-009, AC-010, AC-011, AC-012,
 * AC-013, AC-126): `POST /api/social/accounts` and `GET
 * /api/social/callsigns/{callsign}` over migrations 0054–0056 as the web
 * runtime role `blast_web`, with a real Privy token verifier over a fixture
 * ES256 key, the Postgres rate limiter, blocked terms read from the database
 * and a stubbed Privy users API (never the real provider).
 */

const pendingAccounting = { assets: [], share_bps: 6000, as_of_ms: null, pending_events: 0 };
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-account-create-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-account-create-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 4_000,
  max: 16,
  statementTimeoutMs: 5_000,
};

const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** A Mission Control member: its callsign is taken and its X subject belongs to a member. */
const MEMBER = { id: uuid(0x10), did: "did:privy:create-member", callsign: "taken_one", xSubject: "x-member-subject-10" };
/** A new account that already exists. */
const EXISTING = { id: uuid(0xe1), did: "did:privy:create-existing", callsign: "existing_new" };
const BLOCKED_TERM = "scam";
const did = (name: string) => `did:privy:create-${name}`;

function token(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

let ipSequence = 0;
/** A fresh client IP per request unless one is given, so the per-IP bucket counts only where a test means it to. */
const nextIp = () => `198.51.100.${(ipSequence += 1) % 250}`;

function create(caller: string | null, body: unknown, ip = nextIp()): readonly [Request, ReturnType<typeof testClient>] {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
  if (caller) headers.authorization = `Bearer ${token(caller)}`;
  return [new Request(`${ORIGIN}/api/social/accounts`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), testClient(ip)] as const;
}

function check(caller: string | null, segment: string): readonly [Request, ReturnType<typeof testClient>] {
  const ip = nextIp();
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (caller) headers.authorization = `Bearer ${token(caller)}`;
  return [new Request(`${ORIGIN}/api/social/callsigns/${segment}`, { headers }), testClient(ip)] as const;
}

/** A Privy user with a linked X account (or none), as Privy's users API answers it. */
function privyUser(privyDid: string, x?: Readonly<{ subject: string; username?: string; name?: string; avatar?: string }>) {
  const linked: Record<string, unknown>[] = [{ type: "email", address: "pilot@example.test" }];
  if (x) {
    linked.push({
      type: "twitter_oauth",
      subject: x.subject,
      username: x.username ?? null,
      name: x.name ?? null,
      profile_picture_url: x.avatar ?? null,
      verified_at: NOW - 600,
    });
  }
  return { id: privyDid, linked_accounts: linked };
}

/** The stubbed users API: a DID's user, a failure for a DID marked `fail`, else a user with no X account. */
class FakePrivyUsers {
  readonly users = new Map<string, unknown>();
  readonly failing = new Set<string>();
  calls = 0;

  async getUser(privyDid: string): Promise<unknown> {
    this.calls += 1;
    if (this.failing.has(privyDid)) throw new PrivyAdapterError("PROVIDER_TIMEOUT");
    return this.users.get(privyDid) ?? privyUser(privyDid);
  }
}

/**
 * `pool`, except that each `INSERT INTO social_accounts` waits until `parties`
 * of them are pending: every racer has passed the callsign read before any
 * inserts, so the triggers and unique indexes decide the race.
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

type Routes = ReturnType<typeof createSocialAccountCreationRoutes>;
type Fixture = Readonly<{
  admin: Pool;
  web: Pool;
  privy: FakePrivyUsers;
  routes: Routes;
  /** Routes whose writes wait for `parties` concurrent inserts. */
  racing(parties: number): Routes;
  generating(identities: readonly Readonly<{ callsign: string; displayName: string }>[]): Routes;
  me(caller: string): Promise<SocialMeResponse>;
  shown(caller: string): Promise<Response>;
  referrals(caller?: string): Promise<Response>;
  invitees(caller?: string, query?: string): Promise<Response>;
}>;

async function insertProfile(db: Pool | { query: Pool["query"] }, n: number, privyDid: string, callsign: string, xSubject: string) {
  await db.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, sui_address, provider_wallet_reference, callsign,
       display_name, disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Member', 'fixture-v1', now())`,
    [uuid(n), privyDid, xSubject, callsign, wallet(0x9000 + n), `wallet-${n}`, callsign],
  );
}

async function seed(db: Pool): Promise<void> {
  await insertProfile(db, 0x10, MEMBER.did, MEMBER.callsign, MEMBER.xSubject);
  await db.query(
    `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
     VALUES ($1, 'privy', $2, now()), ($1, 'x', $3, now())`,
    [MEMBER.id, MEMBER.did, MEMBER.xSubject],
  );
  await db.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign, display_name) VALUES ($1, $2, $3, 'Existing')",
    [EXISTING.id, EXISTING.did, EXISTING.callsign],
  );
  await db.query("INSERT INTO social_blocked_terms (term, added_by) VALUES ($1, 'fixture')", [BLOCKED_TERM]);
}

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 8 });
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL_SETTINGS, "social-account-create-test");
  try {
    await seed(admin);
    const accounts = new PostgresSocialAccounts(() => web);
    const privy = new FakePrivyUsers();
    const config = createSocialConfigReader(autocommitReader(web, "social"), { ttlMs: 0 });
    const kitFor = (primary: Pool) => createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => primary,
    });
    const routesFor = (primary: Pool, generateIdentity?: () => Readonly<{ callsign: string; displayName: string }>) => createSocialAccountCreationRoutes({
      kit: kitFor(primary),
      accounts,
      privyUsers: privy,
      findBlockedTerm: config.findBlockedTerm,
      generateIdentity,
    });
    const kit = kitFor(web);
    const meRoute = createSocialMeRoute({ kit, accounts });
    const onboarding = createSocialOnboardingRoutes({ kit });
    await run({
      admin,
      web,
      privy,
      routes: routesFor(web),
      racing: (parties) => routesFor(insertBarrier(web, parties)),
      generating: (identities) => {
        let index = 0;
        return routesFor(web, () => identities[index++] ?? identities.at(-1)!);
      },
      async me(caller) {
        const response = await meRoute.GET(new Request(`${ORIGIN}/api/social/me`, {
          headers: { authorization: `Bearer ${token(caller)}` },
        }), testClient());
        assert.equal(response.status, 200);
        return (await response.json()) as SocialMeResponse;
      },
      invitees: (caller, query = "") => createReferralInviteesRoute(kit).GET(new Request(`${ORIGIN}/api/social/me/referrals/invitees${query}`, {
        headers: caller ? { authorization: `Bearer ${token(caller)}` } : {},
      }), testClient()),
      referrals: (caller) => createReferralRoute(kit).GET(new Request(`${ORIGIN}/api/social/me/referrals`, {
        headers: caller ? { authorization: `Bearer ${token(caller)}` } : {},
      }), testClient()),
      shown: (caller) => onboarding.shown.POST(new Request(`${ORIGIN}/api/social/onboarding/shown`, {
        method: "POST",
        headers: { authorization: `Bearer ${token(caller)}` },
      }), testClient()),
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

/** A 201: the `me` shape with a new account, `private, no-store`, nothing private in the body. */
async function created(response: Response): Promise<SocialCreateAccountResponse["account"]> {
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text) as SocialCreateAccountResponse;
  assert.deepEqual(validator.validate("me-response", body).errors, []);
  assert.ok(body.account);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  assert.doesNotMatch(text, /did:privy|x-subject|x-member-subject/);
  return body.account;
}

async function refusal(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> & { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.ok(response.headers.get("x-request-id"));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return body.error;
}

async function availability(response: Response): Promise<SocialCallsignAvailability> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("callsign-availability-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body as SocialCallsignAvailability;
}

async function accountCount(db: Pool): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM social_accounts")).rows[0]!.n);
}

type StoredAccount = {
  account_id: string;
  privy_did: string;
  callsign: string;
  display_name: string;
  x_subject: string | null;
  x_handle: string | null;
  x_display_name: string | null;
  x_avatar_url: string | null;
};

async function stored(db: Pool, privyDid: string): Promise<StoredAccount | null> {
  return (await db.query<StoredAccount>(
    `SELECT account_id, privy_did, callsign, display_name, x_subject, x_handle, x_display_name, x_avatar_url
     FROM social_accounts WHERE privy_did = $1`,
    [privyDid],
  )).rows[0] ?? null;
}

test("T-014-AC-1 (AC-005, REQ-002): create returns 201 with the callsign lowercased and the X fields, and me then says kind new", { skip }, () =>
  withDatabase(async ({ admin, privy, routes, me, shown }) => {
    const caller = did("kai");
    privy.users.set(caller, privyUser(caller, {
      subject: "x-subject-kai",
      username: "kai_on_x",
      name: "Kai on X",
      avatar: "https://pbs.twimg.com/profile_images/kai.png",
    }));
    assert.deepEqual(await me(caller), { account: null });

    const account = await created(await routes.create.POST(...create(caller, { callsign: "Kai_9", display_name: "Kai" })));
    assert.equal(account.callsign, "kai_9");
    assert.equal(account.kind, "new");
    assert.equal(account.display_name, "Kai");
    assert.equal(account.x_handle, "kai_on_x");
    assert.equal(account.avatar_url, "https://pbs.twimg.com/profile_images/kai.png");
    assert.deepEqual(account.onboarding, { shown: false, completed: false });
    assert.equal(account.privacy, "public");
    assert.deepEqual(account.wallets, []);

    const row = await stored(admin, caller);
    assert.deepEqual(row, {
      account_id: account.account_id,
      privy_did: caller,
      callsign: "kai_9",
      display_name: "Kai",
      x_subject: "x-subject-kai",
      x_handle: "kai_on_x",
      x_display_name: "Kai on X",
      x_avatar_url: "https://pbs.twimg.com/profile_images/kai.png",
    });

    const after = await me(caller);
    assert.equal(after.account?.kind, "new");
    assert.deepEqual(after.account, account);

    // The panel continues: the new account is not onboarded, and the follows step's `shown` now answers it.
    const next = await shown(caller);
    assert.equal(next.status, 200);
    assert.deepEqual(validator.validate("onboarding-shown-response", (await next.json()) as SocialOnboardingShownResponse).errors, []);
  }));

test("T-014-AC-2 (AC-006, AC-013): invalid, reserved and taken callsigns are refused, and the availability check gives the same reason", { skip }, () =>
  withDatabase(async ({ admin, routes, privy }) => {
    const caller = did("picker");
    const before = await accountCount(admin);
    await refusal(await routes.create.POST(...create(caller, { callsign: "k", display_name: "Kai" })), 422, "invalid_callsign");
    await refusal(await routes.create.POST(...create(caller, { callsign: "Admin", display_name: "Kai" })), 422, "callsign_reserved");
    await refusal(await routes.create.POST(...create(caller, { callsign: "Taken_One", display_name: "Kai" })), 409, "callsign_taken");
    // A new account's callsign is taken too: one namespace across both tables.
    await refusal(await routes.create.POST(...create(did("picker-2"), { callsign: EXISTING.callsign, display_name: "Kai" })), 409, "callsign_taken");
    const privyCalls = privy.calls;
    for (const [index, bad] of ["_kai", "kai_", "ka", "a".repeat(21), "kai-9", "kaï_9", " kai_9"].entries()) {
      await refusal(await routes.create.POST(...create(did(`bad-${index}`), { callsign: bad, display_name: "Kai" })), 422, "invalid_callsign");
    }
    // A format refusal never reaches Privy.
    assert.equal(privy.calls, privyCalls);
    assert.equal(await accountCount(admin), before);

    const reasons: Array<[string, SocialCallsignAvailability]> = [
      ["k", { available: false, reason: "invalid" }],
      ["kai-9", { available: false, reason: "invalid" }],
      ["admin", { available: false, reason: "reserved" }],
      ["ADMIN", { available: false, reason: "reserved" }],
      ["taken_one", { available: false, reason: "taken" }],
      ["Taken_One", { available: false, reason: "taken" }],
      [EXISTING.callsign, { available: false, reason: "taken" }],
      ["no_scam_here", { available: false, reason: "blocked" }],
      ["Free_One", { available: true, reason: null }],
      ["kai_9", { available: true, reason: null }],
      ["%20kai", { available: false, reason: "invalid" }],
    ];
    for (const [segment, expected] of reasons) {
      assert.deepEqual(await availability(await routes.callsign.GET(...check(caller, segment))), expected, segment);
    }
    // A malformed path parameter is not a callsign to check.
    await refusal(await routes.callsign.GET(...check(caller, "%E0%A4%A")), 400, "invalid_parameter");
    await refusal(await routes.callsign.GET(...check(caller, "a".repeat(65))), 400, "invalid_parameter");
    // Signed in only.
    await refusal(await routes.callsign.GET(...check(null, "kai_9")), 401, "unauthorized");
    // The owner can keep it; everyone else sees it as taken.
    await created(await routes.create.POST(...create(caller, { callsign: "kai_9", display_name: "Kai" })));
    assert.deepEqual(await availability(await routes.callsign.GET(...check(caller, "KAI_9"))), { available: true, reason: null });
    assert.deepEqual(await availability(await routes.callsign.GET(...check(did("other"), "KAI_9"))), { available: false, reason: "taken" });
  }));

test("T-014-AC-3 (AC-007, AC-009): concurrent creates of one callsign give one 201 and one 409; a second create is account_exists", { skip }, () =>
  withDatabase(async ({ admin, racing, routes }) => {
    // Two users, one free callsign, both past the callsign read before either inserts.
    const pair = racing(2);
    const [first, second] = await Promise.all([
      pair.create.POST(...create(did("racer-a"), { callsign: "same_sign", display_name: "A" })),
      pair.create.POST(...create(did("racer-b"), { callsign: "same_sign", display_name: "B" })),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const loser = first.status === 409 ? first : second;
    await refusal(loser, 409, "callsign_taken");
    await created(first.status === 201 ? first : second);
    assert.equal(
      Number((await admin.query<{ n: string }>("SELECT count(*) AS n FROM social_accounts WHERE callsign = 'same_sign'")).rows[0]!.n),
      1,
    );

    // A stampede of eight: still exactly one.
    const eight = racing(8);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => eight.create.POST(...create(did(`stampede-${index}`), { callsign: "rush_sign", display_name: "R" }))),
    );
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    for (const response of responses.filter((candidate) => candidate.status !== 201)) await refusal(response, 409, "callsign_taken");

    // The winner again, with its own callsign or another: account_exists, and nothing changes.
    const winner = first.status === 201 ? did("racer-a") : did("racer-b");
    const count = await accountCount(admin);
    await refusal(await routes.create.POST(...create(winner, { callsign: "same_sign", display_name: "A" })), 409, "account_exists");
    await refusal(await routes.create.POST(...create(winner, { callsign: "another_sign", display_name: "A" })), 409, "account_exists");
    // A member already has an account (its profile's).
    await refusal(await routes.create.POST(...create(MEMBER.did, { callsign: "member_new", display_name: "M" })), 409, "account_exists");
    assert.equal(await accountCount(admin), count + 1, "only the member's own row was added, by resolution");

    // One caller racing itself with two callsigns: one account.
    const self = racing(2);
    const twice = await Promise.all([
      self.create.POST(...create(did("double"), { callsign: "double_one", display_name: "D" })),
      self.create.POST(...create(did("double"), { callsign: "double_two", display_name: "D" })),
    ]);
    assert.deepEqual(twice.map((response) => response.status).sort(), [201, 409]);
    await refusal(twice.find((response) => response.status === 409)!, 409, "account_exists");
  }));

test("T-014-AC-3 (AC-007): a callsign raced between a Mission Control profile and a new account goes to exactly one of them", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    // The profile's transaction holds the callsign's lock; the account's insert waits for it, then sees the profile.
    const client = await admin.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await insertProfile(client, 0x20, did("mc-first"), "race_mc", "x-race-mc");
      const pending = routes.create.POST(...create(did("sa-second"), { callsign: "race_mc", display_name: "S" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query("COMMIT");
      await refusal(await pending, 409, "callsign_taken");
    } finally {
      client.release();
    }
    assert.equal(await stored(admin, did("sa-second")), null);

    // The account first: the profile's write is refused by the guard.
    await created(await routes.create.POST(...create(did("sa-first"), { callsign: "race_sa", display_name: "S" })));
    await assert.rejects(
      insertProfile(admin, 0x21, did("mc-second"), "race_sa", "x-race-sa"),
      (error: { code?: string; constraint?: string }) =>
        error.code === "23505" && error.constraint === "mission_control_profiles_callsign_taken",
    );

    // Truly concurrent, both tables, several callsigns: each goes to exactly one.
    for (let index = 0; index < 6; index += 1) {
      const callsign = `both_${index}`;
      const [account, profile] = await Promise.allSettled([
        routes.create.POST(...create(did(`both-sa-${index}`), { callsign, display_name: "B" })),
        insertProfile(admin, 0x30 + index, did(`both-mc-${index}`), callsign, `x-both-${index}`),
      ]);
      assert.equal(account.status, "fulfilled");
      const response = (account as PromiseFulfilledResult<Response>).value;
      if (profile.status === "fulfilled") {
        await refusal(response, 409, "callsign_taken");
      } else {
        assert.equal((profile.reason as { constraint?: string }).constraint, "mission_control_profiles_callsign_taken");
        await created(response);
      }
      const holders = await admin.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM social_accounts WHERE callsign = $1)
              + (SELECT count(*) FROM mission_control_profiles WHERE callsign = $1) AS n`,
        [callsign],
      );
      assert.equal(Number(holders.rows[0]!.n), 1, callsign);
    }
  }));

test("T-014-AC-4 (AC-010, AC-012): a member's X subject is member_exists and stores nothing; a Privy failure still creates the account", { skip }, () =>
  withDatabase(async ({ admin, privy, routes }) => {
    const twin = did("x-twin");
    privy.users.set(twin, privyUser(twin, { subject: MEMBER.xSubject, username: "member_x", name: "Member" }));
    const before = await accountCount(admin);
    const error = await refusal(await routes.create.POST(...create(twin, { callsign: "twin_sign", display_name: "Twin" })), 409, "member_exists");
    assert.match(String(error.message), /Sign in with X/);
    assert.doesNotMatch(JSON.stringify(error), /x-member-subject|did:privy/);
    assert.equal(await accountCount(admin), before);
    assert.equal(await stored(admin, twin), null);

    const outage = did("privy-down");
    privy.failing.add(outage);
    const account = await created(await routes.create.POST(...create(outage, { callsign: "outage_sign", display_name: "Out" })));
    assert.equal(account.x_handle, null);
    assert.equal(account.avatar_url, null);
    const row = await stored(admin, outage);
    assert.equal(row?.x_subject, null);
    assert.equal(row?.x_display_name, null);

    // A response for another user is not trusted: no X fields either.
    const confused = did("privy-confused");
    privy.users.set(confused, privyUser(did("someone-else"), { subject: "x-someone", username: "someone" }));
    assert.equal((await created(await routes.create.POST(...create(confused, { callsign: "confused_one", display_name: "C" })))).x_handle, null);

    // No linked X account: no X fields; an unusable handle or avatar is dropped.
    assert.equal((await created(await routes.create.POST(...create(did("no-x"), { callsign: "plain_one", display_name: "P" })))).x_handle, null);
    const odd = did("odd-x");
    privy.users.set(odd, privyUser(odd, { subject: "x-odd", username: "not a handle!", avatar: "http://insecure.example/a.png" }));
    const oddAccount = await created(await routes.create.POST(...create(odd, { callsign: "odd_one", display_name: "O" })));
    assert.equal(oddAccount.x_handle, null);
    assert.equal(oddAccount.avatar_url, null);
    assert.equal((await stored(admin, odd))?.x_subject, "x-odd");
  }));

test("T-014-AC-5 (AC-011, AC-126): display name bounds, blocked terms in either field, and the social_account_create limit", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    for (const [index, name] of ["", "   ", "\t\n", "😀".repeat(33), "a".repeat(33), ` ${"b".repeat(33)} `].entries()) {
      const caller = did(`namer-${index}`);
      await refusal(await routes.create.POST(...create(caller, { callsign: "namer_one", display_name: name })), 422, "invalid_display_name");
      assert.equal(await stored(admin, caller), null);
    }
    // 32 code points (64 UTF-16 units) is allowed; the name is trimmed.
    const emoji = await created(await routes.create.POST(...create(did("emoji"), { callsign: "emoji_one", display_name: ` ${"😀".repeat(32)} ` })));
    assert.equal(emoji.display_name, "😀".repeat(32));
    assert.equal((await created(await routes.create.POST(...create(did("trim"), { callsign: "trim_one", display_name: "  Kai  " })))).display_name, "Kai");

    const blocked = await refusal(await routes.create.POST(...create(did("blocked-1"), { callsign: "no_scam_here", display_name: "Kai" })), 422, "blocked_term");
    assert.equal(blocked.field, "callsign");
    const blockedName = await refusal(await routes.create.POST(...create(did("blocked-2"), { callsign: "fine_sign", display_name: "Total SCAM" })), 422, "blocked_term");
    assert.equal(blockedName.field, "display_name");
    assert.equal(await stored(admin, did("blocked-1")), null);
    assert.equal(await stored(admin, did("blocked-2")), null);

    // Per account: five tries an hour, refusals included; the sixth is 429 with Retry-After.
    const busy = did("busy");
    for (let index = 0; index < 5; index += 1) {
      await refusal(await routes.create.POST(...create(busy, { callsign: "k", display_name: "Kai" })), 422, "invalid_callsign");
    }
    const limited = await routes.create.POST(...create(busy, { callsign: "busy_one", display_name: "Kai" }));
    await refusal(limited.clone(), 429, "rate_limited");
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isSafeInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3_600, String(retryAfter));
    assert.equal(await stored(admin, busy), null);

    // Per IP: five callers from one address, then a sixth caller from it is limited too.
    const ip = "203.0.113.77";
    for (let index = 0; index < 5; index += 1) {
      await refusal(await routes.create.POST(...create(did(`ip-${index}`), { callsign: "k", display_name: "Kai" }, ip)), 422, "invalid_callsign");
    }
    const fromIp = await routes.create.POST(...create(did("ip-fresh"), { callsign: "ip_fresh", display_name: "Kai" }, ip));
    await refusal(fromIp.clone(), 429, "rate_limited");
    assert.ok(Number(fromIp.headers.get("retry-after")) >= 1);
    assert.equal(await stored(admin, did("ip-fresh")), null);
  }));

test("T-014: refusals before any work: no token, closed bodies, and account_exists before the body is read", { skip }, () =>
  withDatabase(async ({ admin, routes, privy }) => {
    const before = await accountCount(admin);
    await refusal(await routes.create.POST(...create(null, { callsign: "kai_9", display_name: "Kai" })), 401, "unauthorized");
    for (const [index, body] of [
      { display_name: "Kai" },
      { callsign: "kai_9", display_name: "Kai", extra: true },
      { callsign: 9, display_name: "Kai" },
      { callsign: "kai_9", display_name: null },
      "not json",
      "[]",
    ].entries()) {
      await refusal(await routes.create.POST(...create(did(`body-${index}`), body)), 400, "invalid_request");
    }
    await refusal(await routes.create.POST(...create(EXISTING.did, "not json")), 409, "account_exists");
    assert.equal(await accountCount(admin), before);
    assert.equal(privy.calls, 0);
  }));

test("UI-08 (OA-7): without a display name the account takes X's name, else its callsign", { skip }, () =>
  withDatabase(async ({ admin, privy, routes }) => {
    // X's name, as sent by Privy.
    const withX = did("derived-x");
    privy.users.set(withX, privyUser(withX, { subject: "x-derived", username: "kaimoreno", name: "Kai Moreno" }));
    const fromX = await created(await routes.create.POST(...create(withX, { callsign: "Kai_Sui" })));
    assert.equal(fromX.display_name, "Kai Moreno");
    assert.equal(fromX.x_handle, "kaimoreno");
    assert.equal((await stored(admin, withX))?.display_name, "Kai Moreno");

    // A long X name keeps its first 32 code points.
    const long = did("derived-long");
    privy.users.set(long, privyUser(long, { subject: "x-long", username: "longname", name: `${"😀".repeat(30)} Moreno` }));
    assert.equal((await created(await routes.create.POST(...create(long, { callsign: "long_one" })))).display_name, `${"😀".repeat(30)} M`);

    // A blocked term in the X name, no X name, no X account, or Privy down: the callsign.
    const blocked = did("derived-blocked");
    privy.users.set(blocked, privyUser(blocked, { subject: "x-blocked", username: "blockedname", name: "Scam Lord" }));
    assert.equal((await created(await routes.create.POST(...create(blocked, { callsign: "clean_one" })))).display_name, "clean_one");
    const nameless = did("derived-nameless");
    privy.users.set(nameless, privyUser(nameless, { subject: "x-nameless", username: "nameless" }));
    assert.equal((await created(await routes.create.POST(...create(nameless, { callsign: "nameless_one" })))).display_name, "nameless_one");
    assert.equal((await created(await routes.create.POST(...create(did("derived-plain"), { callsign: "plain_two" })))).display_name, "plain_two");
    privy.failing.add(did("derived-down"));
    assert.equal((await created(await routes.create.POST(...create(did("derived-down"), { callsign: "down_two" })))).display_name, "down_two");

    // A name that is sent still wins and is still checked.
    assert.equal((await created(await routes.create.POST(...create(did("derived-sent"), { callsign: "sent_one", display_name: " Mine " })))).display_name, "Mine");
    await refusal(await routes.create.POST(...create(did("derived-bad"), { callsign: "bad_one", display_name: " " })), 422, "invalid_display_name");
  }));

test("UI-08 (OA-12): an EVM or Solana wallet-login user creates an account named by its callsign, not verified, and me resolves it", { skip }, () =>
  withDatabase(async ({ privy, routes, me }) => {
    for (const [name, chainType, address] of [
      ["evm", "ethereum", "0x52908400098527886E0F7030069857D2E4169EE7"],
      ["sol", "solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
    ] as const) {
      const caller = did(`wallet-login-${name}`);
      privy.users.set(caller, {
        id: caller,
        linked_accounts: [{ type: "wallet", chain_type: chainType, address, wallet_client_type: "metamask", verified_at: NOW - 60 }],
      });
      assert.equal((await me(caller)).account, null, "signed in, no account yet");
      const account = await created(await routes.create.POST(...create(caller, { callsign: `${name}_pilot` })));
      assert.equal(account.display_name, `${name}_pilot`, "no X: the callsign (OA-7)");
      assert.equal(account.x_handle, null, "no X: not verified (OA-8)");
      assert.deepEqual(account.wallets, [], "an EVM or Solana login wallet is not a Sui wallet");
      assert.deepEqual((await me(caller)).account, account);
    }
  }));

test("new onboarding allocates a saved unique identity, retries collisions and never replaces a member", { skip }, () =>
  withDatabase(async ({ generating, me, routes }) => {
    const generated = generating([
      { callsign: MEMBER.callsign, displayName: "Already Taken" },
      { callsign: "cosmic_otter_1234", displayName: "Cosmic Otter" },
    ]);
    const caller = did("generated");
    const account = await created(await generated.create.POST(...create(caller, {})));
    assert.equal(account.callsign, "cosmic_otter_1234");
    assert.equal(account.display_name, "Cosmic Otter");
    assert.equal(account.kind, "new");
    assert.equal(account.onboarding.completed, true);
    assert.equal(account.onboarding.shown, true);
    assert.equal((await me(caller)).account?.account_id, account.account_id);
    await refusal(await routes.create.POST(...create(caller, {})), 409, "account_exists");
    await refusal(await routes.create.POST(...create(MEMBER.did, {})), 409, "account_exists");
    assert.equal((await me(MEMBER.did)).account?.callsign, MEMBER.callsign);
  }));

function invitedCreate(caller: string, body: unknown, referrer: string): readonly [Request, ReturnType<typeof testClient>] {
  const [request, client] = create(caller, body);
  request.headers.set("cookie", `${REFERRAL_COOKIE}=${referrer}`);
  return [request, client];
}

test("referrals are atomic at signup for generated and explicit identities; existing accounts cannot be claimed", { skip }, async () => {
  await withDatabase(async (fixture) => {
    for (const [name, body] of [["explicit", { callsign: "referred_explicit" }], ["generated", {}]] as const) {
      const response = await fixture.routes.create.POST(...invitedCreate(did(name), body, EXISTING.callsign));
      assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
      const account = await created(response);
      const { rows } = await fixture.admin.query("SELECT referrer_account_id FROM social_accounts WHERE account_id = $1", [account.account_id]);
      assert.equal(rows[0].referrer_account_id, EXISTING.id);
      await refusal(await fixture.routes.create.POST(...invitedCreate(did(name), {}, MEMBER.callsign)), 409, "account_exists");
      await assert.rejects(fixture.web.query("UPDATE social_accounts SET referrer_account_id = NULL WHERE account_id = $1", [account.account_id]), { code: "23514" });
    }
    await refusal(await fixture.routes.create.POST(...invitedCreate(EXISTING.did, {}, MEMBER.callsign)), 409, "account_exists");
    for (const referrer of ["unknown_referrer", "../invalid", "self_referred"]) {
      const account = await created(await fixture.routes.create.POST(...invitedCreate(did(referrer), { callsign: referrer === "self_referred" ? referrer : `invalid_ref_${referrer === "../invalid" ? "two" : "one"}` }, referrer)));
      const { rows } = await fixture.admin.query("SELECT referrer_account_id FROM social_accounts WHERE account_id = $1", [account.account_id]);
      assert.equal(rows[0].referrer_account_id, null);
    }
    await assert.rejects(fixture.web.query("UPDATE social_accounts SET referrer_account_id = $1 WHERE account_id = $1", [EXISTING.id]), { code: "23514" });
    await assert.rejects(fixture.web.query("UPDATE social_accounts SET referrer_account_id = $1 WHERE callsign = 'self_referred'", [EXISTING.id]), { code: "23514" });
  });
});

test("ten invites trading $1,000 each return only a private $10,000 aggregate of confirmed Blast swaps", { skip }, async () => {
  await withDatabase(async (fixture) => {
    let now = Date.now() + 1000;
    const accounts: string[] = [];
    async function trade(n: number, accountId: string, kind: string, state: string, usd: string | null, time = now) {
      const digest = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[n]!.repeat(44);
      await fixture.admin.query(`INSERT INTO social_transactions
        (tx_id, account_id, kind, state, digest, usd_value, idempotency_key, created_at_ms, settled_at_ms, failure_code)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $1::text, $7, $8, $9)`,
      [uuid(0x1000 + n), accountId, kind, state, digest, usd, time, state === "submitted" ? null : time + 1, state === "failed" ? "transaction_failed" : null]);
    }
    for (let n = 0; n < 10; n++) {
      const account = await created(await fixture.routes.create.POST(...invitedCreate(did(`volume-${n}`), { callsign: `volume_invite_${n}` }, EXISTING.callsign)));
      accounts.push(account.account_id);
      const signup = (await fixture.admin.query("SELECT floor(extract(epoch FROM created_at) * 1000)::text AS ms FROM social_accounts WHERE account_id = $1", [account.account_id])).rows[0];
      // A busy host can sign an invite up after `now`; trade after each signup so every invite's swap counts.
      await trade(n, account.account_id, n % 2 ? "trade_sell" : "trade_buy", "confirmed", "1000", Number(signup.ms) + (n === 0 ? 0 : 1));
    }
    now = Date.now() + 1000;
    // Unknown USD is flagged; pending/failed swaps, deposits, unrelated and pre-invite trades never count.
    await trade(20, accounts[0]!, "trade_buy", "confirmed", null);
    await trade(21, accounts[0]!, "deposit", "confirmed", "9000");
    await trade(22, EXISTING.id, "trade_buy", "confirmed", "9000");
    await trade(23, accounts[0]!, "trade_sell", "confirmed", "9000", now - 100_000);
    await trade(24, accounts[0]!, "trade_buy", "submitted", "9000");
    await trade(25, accounts[0]!, "trade_sell", "failed", "9000");
    const response = await fixture.referrals(EXISTING.did);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { invited: 10, volume_usd: "10000.00", unvalued_trades: 1, accounting: pendingAccounting });
    assert.deepEqual(await (await fixture.referrals(EXISTING.did)).json(), { invited: 10, volume_usd: "10000.00", unvalued_trades: 1, accounting: pendingAccounting });
    assert.deepEqual(await (await fixture.referrals(did("volume-0"))).json(), { invited: 0, volume_usd: "0.00", unvalued_trades: 0, accounting: pendingAccounting });
    await refusal(await fixture.referrals(), 401, "unauthorized");
    await refusal(await fixture.referrals(did("no-account")), 409, "account_required");
  });
});

test("old invite links retain attribution after the inviter changes callsign", { skip }, async () => {
  await withDatabase(async (fixture) => {
    await fixture.web.query("UPDATE social_accounts SET callsign = 'renamed_inviter' WHERE account_id = $1", [EXISTING.id]);
    const account = await created(await fixture.routes.create.POST(...invitedCreate(did("alias-invite"), {}, EXISTING.callsign)));
    const { rows } = await fixture.admin.query("SELECT referrer_account_id FROM social_accounts WHERE account_id = $1", [account.account_id]);
    assert.equal(rows[0].referrer_account_id, EXISTING.id);
  });
});

test("launch-code and creator recruits remain in the combined count when social identities are imported", { skip }, async () => {
  await withDatabase(async (fixture) => {
    await insertProfile(fixture.admin, 0x11, did("legacy-recruit"), "legacy_recruit", "x-legacy-recruit");
    const avatar = "https://pbs.twimg.com/profile_images/legacy_normal.jpg";
    await fixture.admin.query("UPDATE mission_control_profiles SET x_avatar_reference = $1 WHERE profile_id = $2", [avatar, uuid(0x11)]);
    await fixture.admin.query(`INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
      VALUES ($1, 'privy', $2, now())`, [uuid(0x11), did("legacy-recruit")]);
    await fixture.admin.query(`INSERT INTO mission_control_invitation_codes
      (code_id, season_id, lookup_key_version, lookup_hmac, encrypted_display, encryption_iv, encryption_tag,
       encryption_key_version, enabled, code_kind, owner_profile_id)
      VALUES ($1, 'season-zero', 'test-v1', $2, 'source', 'aXY=', 'dGFn', 'test-v1', TRUE, 'member', $3)`,
    [uuid(0x55), "f".repeat(64), MEMBER.id]);
    await fixture.admin.query(`INSERT INTO mission_control_referrals
      (recruited_profile_id, referrer_profile_id, source_code_id, created_at) VALUES ($1, $2, $3, now() - interval '1 day')`,
    [uuid(0x11), MEMBER.id, uuid(0x55)]);
    await fixture.me(MEMBER.did);
    const legacyPage = await (await fixture.invitees(MEMBER.did)).json();
    assert.deepEqual(legacyPage.invitees.map((person: { callsign: string | null; display_name: string }) => [person.callsign, person.display_name]), [[null, "Member"]]);
    assert.equal(legacyPage.invitees[0].avatar_url, avatar, "launch-code invitees keep their saved profile image before social import");
    assert.equal(legacyPage.invitees[0].x_handle, "legacy_recruit");
    // Redesign gap: "Joined Oct 24", from the launch-code record seeded a day ago.
    assert.equal(typeof legacyPage.invitees[0].joined_at_ms, "number");
    assert.ok(Math.abs(legacyPage.invitees[0].joined_at_ms - (Date.now() - 86_400_000)) < 120_000, "joined when attributed");
    // Resolving a Mission Control member imports its social identity, without changing its prior referrer.
    await fixture.me(MEMBER.did);
    assert.deepEqual(await (await fixture.referrals(MEMBER.did)).json(), { invited: 1, volume_usd: "0.00", unvalued_trades: 0, accounting: pendingAccounting });
    const recruit = (await fixture.me(did("legacy-recruit"))).account!;
    const importedPage = await (await fixture.invitees(MEMBER.did)).json();
    assert.equal(importedPage.invitees[0].avatar_url, avatar);
    assert.equal(importedPage.invitees[0].x_handle, "legacy_recruit");
    await fixture.admin.query("UPDATE social_accounts SET picture = 'none' WHERE account_id = $1", [recruit.account_id]);
    assert.equal((await (await fixture.invitees(MEMBER.did)).json()).invitees[0].avatar_url, null, "an explicit generated-avatar choice wins over the legacy image");
    const uploaded = "https://images.example.test/uploaded.png";
    await fixture.admin.query("UPDATE social_accounts SET picture = 'upload', picture_url = $1 WHERE account_id = $2", [uploaded, recruit.account_id]);
    assert.equal((await (await fixture.invitees(MEMBER.did)).json()).invitees[0].avatar_url, uploaded);
    await fixture.admin.query(`INSERT INTO social_transactions
      (tx_id, account_id, kind, state, digest, usd_value, idempotency_key, created_at_ms, settled_at_ms)
      VALUES ($1, $2, 'trade_buy', 'confirmed', $3, 1000.25, 'legacy-volume', $4, $4)`,
    [uuid(0x56), recruit.account_id, "z".repeat(44), Date.now()]);
    assert.deepEqual(await (await fixture.referrals(MEMBER.did)).json(), { invited: 1, volume_usd: "1000.25", unvalued_trades: 0, accounting: pendingAccounting });
    await insertProfile(fixture.admin, 0x12, did("creator-recruit"), "creator_recruit", "x-creator-recruit");
    await fixture.admin.query(`INSERT INTO mission_control_seed_creators
      (seed_creator_id, season_id, display_name, expected_x_handle, x_subject, profile_id, claimed_at)
      VALUES ($1, 'season-zero', 'Creator', 'test_creator', 'x-member-subject-10', $2, now())`, [uuid(0x60), MEMBER.id]);
    await fixture.admin.query(`INSERT INTO mission_control_seed_code_groups (seed_code_group_id, seed_creator_id, group_label)
      VALUES ($1, $1, 'Creator')`, [uuid(0x60)]);
    for (const [recruit, code] of [[uuid(0x11), uuid(0x61)], [uuid(0x12), uuid(0x62)]] as const) {
      await fixture.admin.query(`INSERT INTO mission_control_invitation_codes
        (code_id, season_id, lookup_key_version, lookup_hmac, encrypted_display, encryption_iv, encryption_tag,
         encryption_key_version, enabled, code_kind, seed_creator_id, seed_code_group_id)
        VALUES ($1, 'season-zero', 'test-v1', $2, 'source', 'aXY=', 'dGFn', 'test-v1', TRUE, 'creator', $3, $3)`,
      [code, code.replaceAll("-", "").repeat(2), uuid(0x60)]);
      await fixture.admin.query(`INSERT INTO mission_control_seed_creator_attributions
        (recruited_profile_id, seed_creator_id, source_code_id, created_at) VALUES ($1, $2, $3, now() - interval '1 day')`,
      [recruit, uuid(0x60), code]);
    }
    const list = await (await fixture.invitees(MEMBER.did)).json();
    assert.equal(list.invitees.length, 2);
    assert.equal(list.invitees.find((person: { callsign: string | null }) => person.callsign === "legacy_recruit").id, legacyPage.invitees[0].id);
    assert.equal(list.invitees.filter((person: { callsign: string | null }) => person.callsign === "legacy_recruit").length, 1);
    // The same recruit appears in two legacy sources but contributes volume only once.
    assert.deepEqual(await (await fixture.referrals(MEMBER.did)).json(), { invited: 2, volume_usd: "1000.25", unvalued_trades: 0, accounting: pendingAccounting });
  });
});

test("invitees are owner-only, bounded, deduplicated and paged with private per-person accounting", { skip }, async () => {
  await withDatabase(async (fixture) => {
    for (let n = 0; n < 51; n++) {
      await fixture.admin.query(`INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, referrer_account_id, privacy)
        VALUES ($1, $2, $3, $4, $5, $6)`, [uuid(0x8000 + n), did(`list-${n}`), `invited_member_${n}`, `Invitee ${n}`, EXISTING.id, n === 0 ? "private" : "public"]);
    }
    const avatar = "https://pbs.twimg.com/profile_images/new_normal.jpg";
    await fixture.admin.query("UPDATE social_accounts SET x_avatar_url = $1, x_handle = 'new_invitee_x' WHERE account_id = $2", [avatar, uuid(0x8000)]);
    const response = await fixture.invitees(EXISTING.did);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const first = await response.json();
    assert.equal(first.invitees.length, 50);
    assert.equal(first.invitees[0].callsign, "invited_member_0");
    assert.equal(first.invitees[0].avatar_url, avatar);
    assert.equal(first.invitees[0].x_handle, "new_invitee_x");
    assert.equal(first.invitees[1].x_handle, null);
    assert.deepEqual(Object.keys(first.invitees[0]).sort(), ["accounting", "avatar_url", "callsign", "display_name", "id", "joined_at_ms", "x_handle"]);
    assert.ok(Number.isSafeInteger(first.invitees[0].joined_at_ms), "when the invitee joined through the owner");
    const second = await (await fixture.invitees(EXISTING.did, `?cursor=${first.next_cursor}`)).json();
    assert.equal(second.invitees.length, 1);
    assert.equal(second.next_cursor, null);
    assert.equal(new Set([...first.invitees, ...second.invitees].map((person: { id: string }) => person.id)).size, 51);
    await fixture.me(MEMBER.did);
    assert.deepEqual(await (await fixture.invitees(MEMBER.did, `?cursor=${first.next_cursor}`)).json(), { invitees: [], next_cursor: null });
    await refusal(await fixture.invitees(), 401, "unauthorized");
    await refusal(await fixture.invitees(did("no-account")), 409, "account_required");
    await refusal(await fixture.invitees(EXISTING.did, "?cursor=bad"), 400, "invalid_parameter");
    await refusal(await fixture.invitees(EXISTING.did, `?cursor=${first.next_cursor}&cursor=${first.next_cursor}`), 400, "invalid_parameter");
  });
});
