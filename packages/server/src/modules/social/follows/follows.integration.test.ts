import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { FIXTURE_CANCELLED_PRESALE_ID, FIXTURE_PRESALE_ID, rebuildChainRead } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { SOCIAL_FOLLOW_LIMIT } from "@blast/core/modules/social/contracts/follows.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import type { SocialViewerStateResponse } from "@blast/core/modules/social/contracts/viewer-state.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialViewerStateRoute } from "@blast/server/modules/social/viewer-state/route.ts";
import { createSocialFollowRoutes } from "@blast/server/modules/social/follows/route.ts";
import { hex, uuid } from "../../../../../core/test/kit.ts";

/**
 * Social-feed T-009 (AC-033 to AC-036, AC-124 to AC-126, AC-165): the follow
 * routes and `POST /api/social/viewer-state` over the web migrations as the
 * web runtime role `blast_web`, with a real Privy token verifier over a
 * fixture ES256 key and the Postgres rate limiter. The kit's primary is the
 * only pool the routes get, so viewer-state reads where the follow wrote.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-follows-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-follows-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 4_000,
  max: 12,
  statementTimeoutMs: 10_000,
};

/** `kai` follows; `nova` is followed; `busy` fills buckets; `extra_<n>` are more targets. */
const ACCOUNTS = {
  kai: { id: uuid(0x901), did: "did:privy:follows-kai", callsign: "kai" },
  nova: { id: uuid(0x902), did: "did:privy:follows-nova", callsign: "nova" },
  busy: { id: uuid(0x903), did: "did:privy:follows-busy", callsign: "busy" },
} as const;
const EXTRA = Array.from({ length: 5 }, (_, n) => ({ id: uuid(0x910 + n), did: `did:privy:follows-extra-${n}`, callsign: `extra_${n}` }));
const NOBODY_DID = "did:privy:follows-nobody";
const UNKNOWN_PRESALE = hex("dead");
const ADDRESS = hex("1a2b");

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function call(method: "PUT" | "DELETE", path: string, did: string | null): Request {
  return new Request(`${ORIGIN}${path}`, { method, headers: did ? { authorization: `Bearer ${token(did)}` } : {} });
}

function stateRequest(did: string | null, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (did) headers.authorization = `Bearer ${token(did)}`;
  return new Request(`${ORIGIN}/api/social/viewer-state`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Fixture = Readonly<{
  admin: Pool;
  follows: ReturnType<typeof createSocialFollowRoutes>;
  viewerState: ReturnType<typeof createSocialViewerStateRoute>;
  /** Sends a follow request to the matching handler, as Next's file routes would. */
  send(method: "PUT" | "DELETE", path: string, did: string | null): Promise<Response>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL_SETTINGS, "social-follows-test");
  try {
    await rebuildChainRead(admin);
    for (const account of [...Object.values(ACCOUNTS), ...EXTRA]) {
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarding_shown_at, onboarded_at, privacy, sharing_since)
         VALUES ($1, $2, $3, now(), now(), 'public', now())`,
        [account.id, account.did, account.callsign],
      );
    }
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const follows = createSocialFollowRoutes({ kit });
    await run({
      admin,
      follows,
      viewerState: createSocialViewerStateRoute({ kit }),
      send(method, path, did) {
        const routes = path.startsWith("/api/social/follows/account/") ? follows.account : follows.presale;
        return routes[method](call(method, path, did), testClient());
      },
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

const accountPath = (callsign: string) => `/api/social/follows/account/${callsign}`;
const presalePath = (id: string) => `/api/social/follows/presale/${id}`;

async function noContent(response: Response, label: string): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, 204, `${label}: ${text}`);
  assert.equal(text, "");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

async function refusal(response: Response, status: number, code: string, cacheControl = "no-store"): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), cacheControl);
  assert.ok(response.headers.get("x-request-id"));
  return body.error;
}

type FollowRow = { target_kind: string; target_id: string; source: string };

async function followsOf(admin: Pool, accountId: string): Promise<FollowRow[]> {
  const result = await admin.query<FollowRow>(
    "SELECT target_kind, target_id, source FROM social_follows WHERE follower_account_id = $1 ORDER BY target_kind, target_id",
    [accountId],
  );
  return result.rows;
}

async function viewerBody(response: Response): Promise<SocialViewerStateResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("viewer-state-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialViewerStateResponse;
}

test("T-009-AC-1 (AC-033): PUT twice then DELETE twice on both kinds is 204 each time; one row, then none", { skip }, () =>
  withDatabase(async ({ admin, send }) => {
    const { kai, nova } = ACCOUNTS;
    for (const [kind, path, targetId] of [
      ["account", accountPath(nova.callsign), nova.id],
      ["presale", presalePath(FIXTURE_PRESALE_ID), FIXTURE_PRESALE_ID],
    ] as const) {
      await noContent(await send("PUT", path, kai.did), `${kind} PUT 1`);
      await noContent(await send("PUT", path, kai.did), `${kind} PUT 2`);
      assert.deepEqual(await followsOf(admin, kai.id), [{ target_kind: kind, target_id: targetId, source: "user" }]);
      await noContent(await send("DELETE", path, kai.did), `${kind} DELETE 1`);
      assert.deepEqual(await followsOf(admin, kai.id), []);
      await noContent(await send("DELETE", path, kai.did), `${kind} DELETE 2`);
      assert.deepEqual(await followsOf(admin, kai.id), []);
    }
    // Ten concurrent PUTs of one target still store one row.
    const racers = await Promise.all(Array.from({ length: 10 }, () => send("PUT", presalePath(FIXTURE_PRESALE_ID), kai.did)));
    for (const [n, response] of racers.entries()) await noContent(response, `racer ${n}`);
    assert.equal((await followsOf(admin, kai.id)).length, 1);
    // A PUT keeps an existing follow's source.
    await admin.query(
      "INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'default')",
      [kai.id, nova.id],
    );
    await noContent(await send("PUT", accountPath(nova.callsign), kai.did), "PUT over a default follow");
    assert.equal((await followsOf(admin, kai.id)).find((row) => row.target_kind === "account")?.source, "default");
  }));

test("T-009-AC-2 (AC-034): self is cannot_follow_self, unknown targets are not_found, nothing is stored", { skip }, () =>
  withDatabase(async ({ admin, send }) => {
    const { kai } = ACCOUNTS;
    await refusal(await send("PUT", accountPath(kai.callsign), kai.did), 422, "cannot_follow_self");
    // Unfollowing oneself has nothing to remove.
    await noContent(await send("DELETE", accountPath(kai.callsign), kai.did), "DELETE self");
    await refusal(await send("PUT", accountPath("nobody_here"), kai.did), 404, "not_found");
    await refusal(await send("DELETE", accountPath("nobody_here"), kai.did), 404, "not_found");
    await refusal(await send("PUT", presalePath(UNKNOWN_PRESALE), kai.did), 404, "not_found");
    // A presale follow can always be removed, even of a presale the indexer no longer lists.
    await noContent(await send("DELETE", presalePath(UNKNOWN_PRESALE), kai.did), "DELETE unknown presale");
    // A cancelled presale is still a presale.
    await noContent(await send("PUT", presalePath(FIXTURE_CANCELLED_PRESALE_ID), kai.did), "PUT cancelled presale");
    await noContent(await send("DELETE", presalePath(FIXTURE_CANCELLED_PRESALE_ID), kai.did), "DELETE cancelled presale");

    // Malformed path parameters, an address in the account route included, are invalid_parameter.
    for (const [path, parameter] of [
      [accountPath(ADDRESS), "callsign"],
      [accountPath("Kai"), "callsign"],
      [accountPath("k"), "callsign"],
      [accountPath("kai%2Fnova"), "callsign"],
      [accountPath("%E0%A4%A"), "callsign"],
      [accountPath(""), "callsign"],
      [presalePath(ADDRESS.toUpperCase().replace("0X", "0x")), "presale_id"],
      [presalePath("0x1234"), "presale_id"],
      [presalePath(`${FIXTURE_PRESALE_ID}/x`), "presale_id"],
    ] as const) {
      for (const method of ["PUT", "DELETE"] as const) {
        const error = await refusal(await send(method, path, kai.did), 400, "invalid_parameter");
        assert.equal(error.parameter, parameter, `${method} ${path}`);
      }
    }

    // Visitors are unauthorized; a signed-in caller without an account is account_required.
    await refusal(await send("PUT", presalePath(FIXTURE_PRESALE_ID), null), 401, "unauthorized");
    await refusal(await send("PUT", presalePath(FIXTURE_PRESALE_ID), NOBODY_DID), 409, "account_required");
    await refusal(await send("DELETE", accountPath("nova"), null), 401, "unauthorized");
    assert.equal((await admin.query("SELECT 1 FROM social_follows")).rowCount, 0);
  }));

test("T-009-AC-3 (AC-035): with 5,000 follows the next new PUT is follow_limit, even under concurrency", { skip }, () =>
  withDatabase(async ({ admin, send }) => {
    const { kai } = ACCOUNTS;
    const seedFollows = (count: number) =>
      admin.query(
        `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
         SELECT $1, 'presale', '0x' || lpad(to_hex(n), 64, '0'), 'user' FROM generate_series(1, $2::int) AS n`,
        [kai.id, count],
      );
    await seedFollows(SOCIAL_FOLLOW_LIMIT - 1);
    await noContent(await send("PUT", accountPath("nova"), kai.did), "the 5,000th follow");
    await refusal(await send("PUT", presalePath(FIXTURE_PRESALE_ID), kai.did), 422, "follow_limit");
    await refusal(await send("PUT", accountPath("busy"), kai.did), 422, "follow_limit");
    const count = async () => Number((await admin.query("SELECT count(*) FROM social_follows WHERE follower_account_id = $1", [kai.id])).rows[0].count);
    assert.equal(await count(), SOCIAL_FOLLOW_LIMIT);
    // Re-following a followed target is still a success at the limit; removing one makes room.
    await noContent(await send("PUT", accountPath("nova"), kai.did), "PUT existing at limit");
    await noContent(await send("DELETE", presalePath(hex("1")), kai.did), "DELETE at limit");
    await noContent(await send("PUT", presalePath(FIXTURE_PRESALE_ID), kai.did), "PUT after making room");
    assert.equal(await count(), SOCIAL_FOLLOW_LIMIT);

    // One slot left and five concurrent new follows: exactly one is stored. A barrier holds
    // every insert until all five requests are inside their transactions, so without the
    // follower lock all five would count 4,999 and insert.
    await send("DELETE", presalePath(FIXTURE_PRESALE_ID), kai.did);
    assert.equal(await count(), SOCIAL_FOLLOW_LIMIT - 1);
    const barrier = await admin.connect();
    let responses: Response[];
    try {
      await barrier.query("BEGIN");
      await barrier.query("LOCK TABLE social_follows IN SHARE MODE");
      const pending = Promise.all(EXTRA.map((extra) => send("PUT", accountPath(extra.callsign), kai.did)));
      for (let waited = 0; ; waited += 1) {
        const waiting = await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (waiting.rows[0].n >= EXTRA.length) break;
        assert.ok(waited < 300, "the five follows never reached the barrier");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await barrier.query("COMMIT");
      responses = await pending;
    } finally {
      barrier.release();
    }
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [204, 422, 422, 422, 422]);
    for (const response of responses.filter((r) => r.status === 422)) await refusal(response, 422, "follow_limit");
    assert.equal(await count(), SOCIAL_FOLLOW_LIMIT);
  }));

test("T-009-AC-4 (AC-125, AC-124, AC-165): viewer-state is bounded, private, no-store and shows own follows at once", { skip }, () =>
  withDatabase(async ({ admin, send, viewerState }) => {
    const { kai, nova } = ACCOUNTS;
    const entryIds = (n: number) => Array.from({ length: n }, (_, i) => `a:${i}:0:0:0`);
    const callsigns = (n: number) => Array.from({ length: n }, (_, i) => `crew_${String(i).padStart(3, "0")}`);
    const presaleIds = (n: number) => Array.from({ length: n }, (_, i) => hex(`c${i}`));

    // 51 ids in any list, malformed ids, unknown keys and bad bodies are invalid_request, private and no-store.
    for (const body of [
      { entry_ids: entryIds(51) },
      { callsigns: callsigns(51) },
      { presale_ids: presaleIds(51) },
      { entry_ids: ["x:1"] },
      { callsigns: [ADDRESS] },
      { presale_ids: ["0xABC"] },
      { entry_ids: "a:1:0:0:0" },
      { entry_ids: [1] },
      { addresses: [ADDRESS] },
      "not json",
      [],
    ]) {
      await refusal(await viewerState.POST(stateRequest(kai.did, body), testClient()), 400, "invalid_request", "private, no-store");
    }
    await refusal(await viewerState.POST(stateRequest(null, {}), testClient()), 401, "unauthorized", "private, no-store");
    await refusal(await viewerState.POST(stateRequest(NOBODY_DID, {}), testClient()), 409, "account_required", "private, no-store");

    // Exactly 50 of each is accepted, and every requested id is answered. Three full lists of
    // long ids pass the kit's 4 KiB body limit, so a client splits them (body_too_large otherwise).
    const full = await viewerBody(await viewerState.POST(stateRequest(kai.did, { entry_ids: entryIds(50), callsigns: callsigns(50) }), testClient()));
    assert.equal(Object.keys(full.reactions).length, 50);
    assert.equal(Object.keys(full.follows.accounts).length, 50);
    const presales = await viewerBody(await viewerState.POST(stateRequest(kai.did, { presale_ids: presaleIds(50) }), testClient()));
    assert.equal(Object.keys(presales.follows.presales).length, 50);
    await refusal(
      await viewerState.POST(stateRequest(kai.did, { entry_ids: entryIds(50), callsigns: callsigns(50), presale_ids: presaleIds(50) }), testClient()),
      413,
      "body_too_large",
      "private, no-store",
    );
    assert.deepEqual(await viewerBody(await viewerState.POST(stateRequest(kai.did, {}), testClient())), {
      reactions: {},
      follows: { accounts: {}, presales: {} },
      backers: {},
      follows_you: {},
    });

    // A follow made just before shows true at once; an unfollow shows false at once.
    const ask = { entry_ids: ["a:1:0:0:0"], callsigns: [nova.callsign, "nobody_here"], presale_ids: [FIXTURE_PRESALE_ID, UNKNOWN_PRESALE] };
    assert.deepEqual(await viewerBody(await viewerState.POST(stateRequest(kai.did, ask), testClient())), {
      reactions: { "a:1:0:0:0": [] },
      follows: { accounts: { nova: false, nobody_here: false }, presales: { [FIXTURE_PRESALE_ID]: false, [UNKNOWN_PRESALE]: false } },
      backers: {},
      follows_you: {},
    });
    await noContent(await send("PUT", accountPath(nova.callsign), kai.did), "follow nova");
    await noContent(await send("PUT", presalePath(FIXTURE_PRESALE_ID), kai.did), "follow presale");
    await admin.query(
      "INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ('a:1:0:0:0', $1, 'fire'), ('a:1:0:0:0', $1, 'bull'), ('a:1:0:0:0', $2, 'eyes')",
      [kai.id, nova.id],
    );
    assert.deepEqual(await viewerBody(await viewerState.POST(stateRequest(kai.did, ask), testClient())), {
      reactions: { "a:1:0:0:0": ["bull", "fire"] },
      follows: { accounts: { nova: true, nobody_here: false }, presales: { [FIXTURE_PRESALE_ID]: true, [UNKNOWN_PRESALE]: false } },
      backers: {},
      follows_you: {},
    });
    // Another viewer sees only their own state.
    assert.deepEqual(await viewerBody(await viewerState.POST(stateRequest(nova.did, ask), testClient())), {
      reactions: { "a:1:0:0:0": ["eyes"] },
      follows: { accounts: { nova: false, nobody_here: false }, presales: { [FIXTURE_PRESALE_ID]: false, [UNKNOWN_PRESALE]: false } },
      backers: {},
      follows_you: {},
    });
    await noContent(await send("DELETE", accountPath(nova.callsign), kai.did), "unfollow nova");
    const after = await viewerBody(await viewerState.POST(stateRequest(kai.did, { callsigns: [nova.callsign] }), testClient()));
    assert.deepEqual(after.follows.accounts, { nova: false });
  }));

test("T-009-AC-5 (AC-126): past 120 follow writes a minute the next is rate_limited with Retry-After, per account", { skip }, () =>
  withDatabase(async ({ admin, send }) => {
    const { busy, kai } = ACCOUNTS;
    // The limiter's windows are fixed minutes: start the burst with at least 20 s
    // of the window left, so all 121 writes fall in one window.
    const into = Date.now() % 60_000;
    if (into > 40_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - into + 100));
    // PUTs and DELETEs share the bucket.
    for (let n = 0; n < 120; n += 1) {
      const response = await send(n % 2 === 0 ? "PUT" : "DELETE", presalePath(FIXTURE_PRESALE_ID), busy.did);
      assert.equal(response.status, 204, `request ${n}`);
    }
    const limited = await send("PUT", presalePath(FIXTURE_PRESALE_ID), busy.did);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    await refusal(limited, 429, "rate_limited");
    assert.deepEqual(await followsOf(admin, busy.id), []);
    // Another account is not limited.
    await noContent(await send("PUT", presalePath(FIXTURE_PRESALE_ID), kai.did), "another account");
  }));
