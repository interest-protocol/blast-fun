import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, OPAQUE_SESSION_COOKIE_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import {
  createPool,
  migrateDatabase,
} from "@blast/core/modules/database/admin.ts";
import { recordStatements } from "../../../../../core/test/fixtures/modules/database/testing.ts";
import {
  createMemberSessionLogoutHandler,
  getMemberSession,
  issueMemberSession,
  MemberSessionError,
  MemberSessionService,
} from "@blast/server/modules/mission-control/member-sessions/index.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const ORIGIN = "https://blast.fun";
const PROFILE_ID = "d0000000-0000-4000-8000-000000000023";
const CSRF = "c".repeat(43);
const DAY_MS = 24 * 60 * 60 * 1_000;
const START = new Date("2026-09-20T12:00:00.000Z");
const TOKENS = ["a", "b", "d", "e", "f", "g"].map((value) =>
  value.repeat(43),
);

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function sessionRequest(cookie: string): Request {
  return new Request(`${ORIGIN}/api/member`, {
    headers: { Cookie: cookiePair(cookie) },
  });
}

function mutationRequest(cookie: string, csrfHeader = CSRF): Request {
  return new Request(`${ORIGIN}/api/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: `${cookiePair(cookie)}; ${CSRF_COOKIE_NAME}=${CSRF}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      [CSRF_HEADER_NAME]: csrfHeader,
    },
  });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof MemberSessionError ? error.code : undefined;
}

test(
  "opaque sessions issue, refresh, expire, revoke, and logout without secret leakage",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 8 });
    let now = new Date(START);
    let tokenIndex = 0;
    const service = new MemberSessionService({
      clock: () => new Date(now),
      pool,
      tokenFactory: () => TOKENS[tokenIndex++] ?? "z".repeat(43),
    });

    async function issue(): Promise<string> {
      let cookie = "";
      const authorization = await issueMemberSession(
        mutationRequest(`${OPAQUE_SESSION_COOKIE_NAME}=unused`),
        ORIGIN,
        service,
        { profileId: PROFILE_ID },
        (value) => { cookie = value; },
      );
      assert.deepEqual(authorization, {
        profileId: PROFILE_ID,
        scope: "member",
      });
      assert.deepEqual(Object.keys(authorization).sort(), ["profileId", "scope"]);
      assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
      return cookie;
    }

    try {
      const applied = await migrateDatabase(pool);
      assert.ok(applied.includes("0006_member_sessions"));
      await pool.query(
        `INSERT INTO mission_control_profiles (
           profile_id, privy_did, x_subject, sui_address,
           provider_wallet_reference, callsign, disclosure_version,
           disclosure_accepted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          PROFILE_ID,
          "did:privy:member-session-fixture",
          "x-subject-member-session-fixture",
          `0x${"23".repeat(32)}`,
          "wallet-member-session-fixture",
          "session_pilot",
          "automatic-disclosure-v1",
          START,
        ],
      );

      let rejectedCookie = "";
      const wrongOrigin = new Request(`${ORIGIN}/api/complete`, {
        method: "POST",
        headers: {
          Cookie: `${CSRF_COOKIE_NAME}=${CSRF}`,
          Origin: "https://evil.example",
          [CSRF_HEADER_NAME]: CSRF,
        },
      });
      await assert.rejects(
        issueMemberSession(
          wrongOrigin,
          ORIGIN,
          service,
          { profileId: PROFILE_ID },
          (value) => { rejectedCookie = value; },
        ),
        (error: unknown) =>
          error instanceof Error && error.name === "WebSecurityError",
      );
      assert.equal(rejectedCookie, "");
      assert.equal(
        (await pool.query("SELECT COUNT(*) FROM mission_control_member_sessions"))
          .rows[0]?.count,
        "0",
      );

      const rollingCookie = await issue();
      const rollingToken = cookiePair(rollingCookie).split("=")[1] ?? "";
      const stored = await pool.query<{
        token_hash: string;
        idle_expires_at: Date;
        absolute_expires_at: Date;
      }>(
        `SELECT token_hash, idle_expires_at, absolute_expires_at
         FROM mission_control_member_sessions
         WHERE profile_id = $1
         ORDER BY created_at
         LIMIT 1`,
        [PROFILE_ID],
      );
      assert.notEqual(stored.rows[0]?.token_hash, rollingToken);
      assert.equal(
        stored.rows[0]?.token_hash,
        createHash("sha256").update(rollingToken).digest("hex"),
      );
      assert.equal(stored.rows[0]?.idle_expires_at.toISOString(), "2026-09-27T12:00:00.000Z");
      assert.equal(stored.rows[0]?.absolute_expires_at.toISOString(), "2026-10-20T12:00:00.000Z");

      now = new Date(START.getTime() + 6 * DAY_MS);
      assert.deepEqual(await getMemberSession(sessionRequest(rollingCookie), service), {
        profileId: PROFILE_ID,
        scope: "member",
      });
      const refreshed = await pool.query<{ idle_expires_at: Date }>(
        `SELECT idle_expires_at
         FROM mission_control_member_sessions
         WHERE token_hash = $1`,
        [createHash("sha256").update(rollingToken).digest("hex")],
      );
      assert.equal(refreshed.rows[0]?.idle_expires_at.toISOString(), "2026-10-03T12:00:00.000Z");

      now = new Date(START.getTime() + 13 * DAY_MS);
      await assert.rejects(
        getMemberSession(sessionRequest(rollingCookie), service),
        (error) => errorCode(error) === "SESSION_INVALID",
      );

      now = new Date(START);
      const absoluteCookie = await issue();
      for (const day of [6, 12, 18, 24, 29]) {
        now = new Date(START.getTime() + day * DAY_MS);
        await getMemberSession(sessionRequest(absoluteCookie), service);
      }
      const absoluteToken = cookiePair(absoluteCookie).split("=")[1] ?? "";
      const absoluteRow = await pool.query<{ idle_expires_at: Date }>(
        `SELECT idle_expires_at
         FROM mission_control_member_sessions
         WHERE token_hash = $1`,
        [createHash("sha256").update(absoluteToken).digest("hex")],
      );
      assert.equal(absoluteRow.rows[0]?.idle_expires_at.toISOString(), "2026-10-20T12:00:00.000Z");
      now = new Date(START.getTime() + 30 * DAY_MS);
      await assert.rejects(
        getMemberSession(sessionRequest(absoluteCookie), service),
        (error) => errorCode(error) === "SESSION_INVALID",
      );

      now = new Date(START);
      const idleCookie = await issue();
      now = new Date(START.getTime() + 7 * DAY_MS);
      await assert.rejects(
        getMemberSession(sessionRequest(idleCookie), service),
        (error) => errorCode(error) === "SESSION_INVALID",
      );

      now = new Date(START);
      const revokedCookie = await issue();
      now = new Date(START.getTime() + DAY_MS);
      assert.equal(await service.revoke(sessionRequest(revokedCookie)), true);
      await assert.rejects(
        getMemberSession(sessionRequest(revokedCookie), service),
        (error) => errorCode(error) === "SESSION_INVALID",
      );
      assert.equal(await service.revoke(sessionRequest(revokedCookie)), false);

      now = new Date(START);
      const logoutCookie = await issue();
      const logout = createMemberSessionLogoutHandler({
        expectedOrigin: ORIGIN,
        service,
      });
      const invalidCsrf = await logout(mutationRequest(logoutCookie, "x".repeat(43)));
      assert.equal(invalidCsrf.status, 403);
      assert.deepEqual(await getMemberSession(sessionRequest(logoutCookie), service), {
        profileId: PROFILE_ID,
        scope: "member",
      });
      const logoutResponse = await logout(mutationRequest(logoutCookie));
      assert.equal(logoutResponse.status, 204);
      assert.match(logoutResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
      assert.doesNotMatch(logoutResponse.headers.get("set-cookie") ?? "", new RegExp(TOKENS[4] ?? ""));
      await assert.rejects(
        getMemberSession(sessionRequest(logoutCookie), service),
        (error) => errorCode(error) === "SESSION_INVALID",
      );

      await assert.rejects(
        getMemberSession(
          sessionRequest(`${OPAQUE_SESSION_COOKIE_NAME}=${"z".repeat(43)}`),
          service,
        ),
        (error) => errorCode(error) === "SESSION_INVALID",
      );

      const schema = await pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'mission_control_member_sessions'`,
      );
      assert.equal(
        schema.rows.some(({ column_name }) => /raw|cookie|token_value/.test(column_name)),
        false,
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "parallel authorizations read the session and refresh it at most once per interval",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 40 });
    const statements = recordStatements(pool);
    const profileId = "d0000000-0000-4000-8000-000000000024";
    const tokens = ["k", "m", "n"].map((value) => value.repeat(43));
    const MINUTE_MS = 60_000;

    function serviceAt(clock: Date): MemberSessionService {
      return new MemberSessionService({
        clock: () => new Date(clock),
        pool,
        tokenFactory: () => tokens.shift() ?? "y".repeat(43),
      });
    }

    async function issueAt(clock: Date): Promise<string> {
      let cookie = "";
      await issueMemberSession(
        mutationRequest(`${OPAQUE_SESSION_COOKIE_NAME}=unused`),
        ORIGIN,
        serviceAt(clock),
        { profileId },
        (value) => { cookie = value; },
      );
      return cookie;
    }

    async function authorizeAll(cookie: string, clocks: readonly Date[]) {
      return Promise.allSettled(
        clocks.map((clock) => serviceAt(clock).authorize(sessionRequest(cookie))),
      );
    }

    async function stored(cookie: string) {
      const token = cookiePair(cookie).split("=")[1] ?? "";
      const result = await pool.query<{
        idle_expires_at: Date;
        last_seen_at: Date;
        updates: number;
      }>(
        `SELECT session.idle_expires_at, session.last_seen_at, probe.updates
         FROM mission_control_member_sessions session
         CROSS JOIN member_session_update_probe probe
         WHERE session.token_hash = $1`,
        [createHash("sha256").update(token).digest("hex")],
      );
      const row = result.rows[0];
      assert.ok(row);
      return row;
    }

    /** Counts the statements sent since `mark` by their first keyword. */
    function sentSince(mark: number): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const text of statements.slice(mark)) {
        const keyword = text.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
        counts[keyword] = (counts[keyword] ?? 0) + 1;
      }
      return counts;
    }

    function allAuthorized(results: readonly PromiseSettledResult<unknown>[]): void {
      const failures = results.filter((result) => result.status === "rejected");
      assert.deepEqual(
        failures.map((failure) => errorCode((failure as PromiseRejectedResult).reason)),
        [],
      );
      for (const result of results) {
        assert.deepEqual((result as PromiseFulfilledResult<unknown>).value, {
          profileId,
          scope: "member",
        });
      }
    }

    try {
      await migrateDatabase(pool);
      await pool.query(
        `INSERT INTO mission_control_profiles (
           profile_id, privy_did, x_subject, sui_address,
           provider_wallet_reference, callsign, disclosure_version,
           disclosure_accepted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          profileId,
          "did:privy:member-session-race-fixture",
          "x-subject-member-session-race-fixture",
          `0x${"24".repeat(32)}`,
          "wallet-member-session-race-fixture",
          "session_racer",
          "automatic-disclosure-v1",
          START,
        ],
      );
      // Test-only probe: counts every row version written to the session table.
      await pool.query("CREATE TABLE member_session_update_probe (updates INT NOT NULL)");
      await pool.query("INSERT INTO member_session_update_probe VALUES (0)");
      await pool.query(
        `CREATE FUNCTION member_session_count_update() RETURNS TRIGGER
         LANGUAGE plpgsql AS $$
         BEGIN
           UPDATE member_session_update_probe SET updates = updates + 1;
           RETURN NEW;
         END;
         $$`,
      );
      await pool.query(
        `CREATE TRIGGER member_session_count_update
         AFTER UPDATE ON mission_control_member_sessions
         FOR EACH ROW EXECUTE FUNCTION member_session_count_update()`,
      );

      const cookie = await issueAt(START);
      const issued = await stored(cookie);
      assert.equal(issued.updates, 0);

      // A fresh session: 30 simultaneous requests, clocks from a minute before
      // the stored activity to almost nine minutes after it, all read-only:
      // one autocommit SELECT each, no BEGIN or COMMIT.
      let mark = statements.length;
      const fresh = await authorizeAll(
        cookie,
        Array.from({ length: 30 }, (_, index) =>
          new Date(START.getTime() - MINUTE_MS + index * 20_000),
        ),
      );
      allAuthorized(fresh);
      assert.deepEqual(sentSince(mark), { SELECT: 30 });
      const afterFresh = await stored(cookie);
      assert.equal(afterFresh.updates, 0);
      assert.equal(afterFresh.last_seen_at.toISOString(), START.toISOString());

      // A stale session: 30 simultaneous requests with clocks jittered two
      // minutes either side of +30 minutes. One refresh wins; the rest skip.
      const staleAt = START.getTime() + 30 * MINUTE_MS;
      mark = statements.length;
      const stale = await authorizeAll(
        cookie,
        Array.from({ length: 30 }, (_, index) =>
          new Date(staleAt - 2 * MINUTE_MS + ((index * 7) % 30) * 8_000),
        ),
      );
      allAuthorized(stale);
      const staleSent = sentSince(mark);
      assert.equal(staleSent.SELECT, 30);
      assert.ok(
        (staleSent.UPDATE ?? 0) >= 1 && (staleSent.UPDATE ?? 0) <= 30,
        "only requests that read a stale session try the guarded refresh",
      );
      assert.deepEqual(Object.keys(staleSent).sort(), ["SELECT", "UPDATE"]);
      const afterStale = await stored(cookie);
      assert.equal(afterStale.updates, 1);
      assert.ok(afterStale.last_seen_at >= afterFresh.last_seen_at);
      assert.ok(afterStale.last_seen_at.getTime() >= staleAt - 2 * MINUTE_MS);
      assert.ok(afterStale.last_seen_at.getTime() <= staleAt + 2 * MINUTE_MS);
      assert.equal(
        afterStale.idle_expires_at.getTime() - afterStale.last_seen_at.getTime(),
        7 * DAY_MS,
      );

      // Clocks behind the stored activity authorize without writing.
      mark = statements.length;
      const behind = await authorizeAll(
        cookie,
        Array.from({ length: 25 }, (_, index) =>
          new Date(START.getTime() + 20 * MINUTE_MS + index * 1_000),
        ),
      );
      allAuthorized(behind);
      assert.deepEqual(sentSince(mark), { SELECT: 25 });
      const afterBehind = await stored(cookie);
      assert.equal(afterBehind.updates, 1);
      assert.equal(
        afterBehind.last_seen_at.toISOString(),
        afterStale.last_seen_at.toISOString(),
      );

      // Once the interval has passed again, the next request refreshes once.
      const later = new Date(afterBehind.last_seen_at.getTime() + 11 * MINUTE_MS);
      mark = statements.length;
      allAuthorized(await authorizeAll(cookie, [later]));
      assert.deepEqual(sentSince(mark), { SELECT: 1, UPDATE: 1 });
      const afterLater = await stored(cookie);
      assert.equal(afterLater.updates, 2);
      assert.equal(afterLater.last_seen_at.toISOString(), later.toISOString());
      assert.equal(
        afterLater.idle_expires_at.toISOString(),
        new Date(later.getTime() + 7 * DAY_MS).toISOString(),
      );

      // Revocation takes effect at once, inside the refresh interval.
      const revokedAt = new Date(later.getTime() + 1_000);
      assert.equal(await serviceAt(revokedAt).revoke(sessionRequest(cookie)), true);
      mark = statements.length;
      const afterRevoke = await authorizeAll(
        cookie,
        Array.from({ length: 10 }, (_, index) =>
          new Date(revokedAt.getTime() + index * 1_000),
        ),
      );
      assert.ok(
        afterRevoke.every(
          (result) =>
            result.status === "rejected" && errorCode(result.reason) === "SESSION_INVALID",
        ),
      );
      assert.deepEqual(sentSince(mark), { SELECT: 10 });
      assert.equal((await stored(cookie)).updates, 3, "revocation was the only write");

      // Idle and absolute expiry are enforced by the read, not by the refresh.
      const idleCookie = await issueAt(START);
      const idleExpired = await authorizeAll(idleCookie, [
        new Date(START.getTime() + 7 * DAY_MS),
        new Date(START.getTime() + 7 * DAY_MS + 5 * MINUTE_MS),
      ]);
      assert.ok(
        idleExpired.every(
          (result) =>
            result.status === "rejected" && errorCode(result.reason) === "SESSION_INVALID",
        ),
      );
      const absoluteCookie = await issueAt(START);
      assert.deepEqual(
        await serviceAt(new Date(START.getTime() + 6 * DAY_MS)).authorize(
          sessionRequest(absoluteCookie),
        ),
        { profileId, scope: "member" },
      );
      const absoluteExpired = await authorizeAll(absoluteCookie, [
        new Date(START.getTime() + 30 * DAY_MS),
      ]);
      assert.ok(
        absoluteExpired.every(
          (result) =>
            result.status === "rejected" && errorCode(result.reason) === "SESSION_INVALID",
        ),
      );
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS member_session_count_update ON mission_control_member_sessions",
      );
      await pool.query("DROP FUNCTION IF EXISTS member_session_count_update()");
      await pool.query("DROP TABLE IF EXISTS member_session_update_probe");
      await pool.end();
    }
  },
);
