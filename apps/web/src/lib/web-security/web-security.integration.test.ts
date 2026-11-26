import assert from "node:assert/strict";
import test from "node:test";

import { createPool } from "@blast/core/modules/database/pool.ts";
import {
  migrateDatabase,
  resetDatabase,
} from "@blast/core/modules/database/admin.ts";
import { AdaptiveChallengeController, PostgresAdaptiveDecisionAuditSink } from "@blast/server/lib/web-security/adaptive-challenge.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createRatePolicyRegistry, DEFAULT_RATE_POLICIES, PRESALE_RATE_BUCKETS, withRateLimit, type RateBucket, type RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";
import { SECURITY_FIXTURES } from "../../../test/fixtures/lib/web-security/fixtures.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const baseTime = new Date("2026-09-20T12:00:00.000Z");
const pepper = "web-security-test-pepper-is-at-least-32-characters";

test(
  "durable rate boundaries and identifier-free audits are authoritative",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    let now = new Date(baseTime);
    const limiter = new PostgresRateLimitEnforcer({
      clock: () => new Date(now),
      pool,
      subjectPepper: pepper,
    });

    async function assertBoundary(
      bucket: RateBucket,
      subject: RateLimitSubject,
      limit: number,
    ) {
      for (let request = 0; request < limit; request += 1) {
        assert.equal((await limiter.consume(bucket, subject)).allowed, true);
      }
      const denied = await limiter.consume(bucket, subject);
      assert.equal(denied.allowed, false);
      assert.ok(denied.retryAfterSeconds > 0);
    }

    try {
      const applied = await migrateDatabase(pool);
      assert.ok(applied.includes("0005_web_security"));

      await assertBoundary("wallet", SECURITY_FIXTURES.wallet, 5);
      await assertBoundary("recovery", SECURITY_FIXTURES.recovery, 5);
      await assertBoundary("callsign", SECURITY_FIXTURES.callsign, 30);
      await assertBoundary("completion", SECURITY_FIXTURES.completion, 5);
      await assertBoundary("telemetry", SECURITY_FIXTURES.telemetry, 12);
      await assertBoundary("oauth", SECURITY_FIXTURES.admission, 10);

      const codeSubject = { ip: "203.0.113.99" };
      for (let minute = 0; minute < 3; minute += 1) {
        now = new Date(baseTime.getTime() + minute * 60_000);
        for (let request = 0; request < 10; request += 1) {
          assert.equal((await limiter.consume("code", codeSubject)).allowed, true);
        }
      }
      now = new Date(baseTime.getTime() + 3 * 60_000);
      assert.equal((await limiter.consume("code", codeSubject)).allowed, false);

      let domainMutations = 0;
      await assert.rejects(
        withRateLimit(limiter, "wallet", SECURITY_FIXTURES.wallet, async () => {
          domainMutations += 1;
        }),
        (error: unknown) =>
          error instanceof WebSecurityError && error.code === "RATE_LIMITED",
      );
      assert.equal(domainMutations, 0);

      const persistedSubjects = await pool.query(
        `SELECT subject_hash
         FROM mission_control_rate_limit_windows
         ORDER BY subject_hash`,
      );
      assert.ok(persistedSubjects.rows.length > 0);
      assert.ok(
        persistedSubjects.rows.every((row) =>
          /^[0-9a-f]{64}$/.test(row.subject_hash),
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(persistedSubjects.rows),
        /203\.0\.113|attempt-fixture|admission-fixture|0x1111|0x2222/,
      );

      const audit = new PostgresAdaptiveDecisionAuditSink(pool);
      const controller = new AdaptiveChallengeController({
        audit,
        clock: () => baseTime,
        verifier: { async verify() { return true; } },
      });
      await controller.enforce({ bucket: "oauth", recentFailures: 0 });
      await controller.enforce({
        bucket: "oauth",
        challengeToken: "ephemeral-token",
        recentFailures: 3,
      });
      const auditRows = await pool.query(
        `SELECT policy_version, bucket, decision, reason, occurred_at
         FROM mission_control_abuse_decision_audit
         ORDER BY occurred_at, decision`,
      );
      assert.equal(auditRows.rows.length, 2);
      assert.doesNotMatch(
        JSON.stringify(auditRows.rows),
        /203\.0\.113|ephemeral-token|device|user|address|session/i,
      );

      const reset = await resetDatabase(pool);
      assert.ok(reset.includes("0005_web_security"));
    } finally {
      await pool.end();
    }
  },
);

test(
  "one-statement rate limits trip at the same counts under concurrency",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 30 });
    const hour = new Date("2026-09-21T09:00:00.000Z").getTime();
    let now = new Date(hour + 15_000);
    const clock = () => new Date(now);
    const limiter = new PostgresRateLimitEnforcer({ clock, pool, subjectPepper: pepper });
    const tenPerWindow = new PostgresRateLimitEnforcer({
      clock,
      policies: createRatePolicyRegistry({ oauth: { limit: 10, windowSeconds: 600 } }),
      pool,
      subjectPepper: pepper,
    });

    async function storedCounts(bucket: RateBucket): Promise<Record<string, number>> {
      const result = await pool.query<{ window_seconds: number; request_count: number }>(
        `SELECT window_seconds, request_count
         FROM mission_control_rate_limit_windows
         WHERE policy_name = $1
         ORDER BY window_seconds`,
        [bucket],
      );
      return Object.fromEntries(
        result.rows.map((row) => [String(row.window_seconds), row.request_count]),
      );
    }

    async function parallel(
      enforcer: PostgresRateLimitEnforcer,
      bucket: RateBucket,
      subject: RateLimitSubject,
      requests: number,
    ) {
      return Promise.all(
        Array.from({ length: requests }, () => enforcer.consume(bucket, subject)),
      );
    }

    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM mission_control_rate_limit_windows");

      // Single window: 30 simultaneous requests against a limit of 10.
      const single = await parallel(tenPerWindow, "oauth", { ip: "198.51.100.1" }, 30);
      assert.equal(single.filter((decision) => decision.allowed).length, 10);
      assert.ok(
        single
          .filter((decision) => !decision.allowed)
          .every((decision) => decision.retryAfterSeconds === 585),
      );

      // Two windows (10/minute, 30/hour): exactly 10 pass, and the 20 refused
      // requests give their counts back, so the hour holds only admitted ones.
      const codeSubject = { ip: "198.51.100.2" };
      const burst = await parallel(limiter, "code", codeSubject, 30);
      assert.equal(burst.filter((decision) => decision.allowed).length, 10);
      assert.ok(
        burst
          .filter((decision) => !decision.allowed)
          .every((decision) => decision.retryAfterSeconds === 45),
      );
      assert.deepEqual(await storedCounts("code"), { "60": 10, "3600": 10 });

      for (const minute of [1, 2]) {
        now = new Date(hour + minute * 60_000 + 5_000);
        const next = await parallel(limiter, "code", codeSubject, 15);
        assert.equal(next.filter((decision) => decision.allowed).length, 10);
      }

      // The hour trips at exactly 30 admitted requests. Sequential retries keep
      // the hour's Retry-After, as the transactional limiter did.
      now = new Date(hour + 3 * 60_000 + 30_000);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        assert.deepEqual(await limiter.consume("code", codeSubject), {
          allowed: false,
          bucket: "code",
          policyVersion: 1,
          retryAfterSeconds: 56 * 60 + 30,
        });
      }
      // A simultaneous burst is refused outright. Until each refund lands, the
      // burst's own counts can fill the minute too, so a refusal may name the
      // minute instead of the hour; it never admits a request.
      const exhausted = await parallel(limiter, "code", codeSubject, 12);
      assert.equal(exhausted.filter((decision) => decision.allowed).length, 0);
      assert.ok(
        exhausted.every((decision) =>
          [30, 56 * 60 + 30].includes(decision.retryAfterSeconds),
        ),
      );
      const hourly = await pool.query<{ request_count: number }>(
        `SELECT request_count
         FROM mission_control_rate_limit_windows
         WHERE policy_name = 'code' AND window_seconds = 3600`,
      );
      assert.deepEqual(hourly.rows.map((row) => row.request_count), [30]);

      now = new Date(hour + 60 * 60_000);
      assert.equal((await limiter.consume("code", codeSubject)).allowed, true);

      // Every default boundary still trips at its configured count.
      now = new Date(hour + 2 * 60 * 60_000);
      for (const [bucket, subject] of [
        ["telegram", { admissionId: "admission-concurrency" }],
        ["share", { sessionId: "session-concurrency" }],
        ["completion", { attemptId: "attempt-concurrency" }],
        ["callsign", { attemptId: "attempt-concurrency" }],
        ["telemetry", { sessionId: "session-concurrency" }],
        ["wallet", { ip: "198.51.100.3", address: "0xabc" }],
      ] as const) {
        const limit = DEFAULT_RATE_POLICIES[bucket].windows[0]?.limit ?? 0;
        const decisions = await parallel(limiter, bucket, subject, limit + 5);
        assert.equal(
          decisions.filter((decision) => decision.allowed).length,
          limit,
          bucket,
        );
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  "presale buckets enforce their limits per Privy account, and the sponsor execute budget is one UTC day",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    // 23:59:30 UTC: the day's last half minute.
    let now = new Date("2026-10-02T23:59:30.000Z");
    const limiter = new PostgresRateLimitEnforcer({ clock: () => new Date(now), pool, subjectPepper: pepper });
    const alice = { accountId: "did:privy:presale-alice", ip: "198.51.100.40" };
    const bob = { accountId: "did:privy:presale-bob", ip: "198.51.100.40" };
    try {
      await migrateDatabase(pool);

      // Account scope: the same IP does not share an account's budget.
      for (let request = 0; request < 100; request += 1) {
        assert.equal((await limiter.consume("presale_sponsor_exec", alice)).allowed, true);
      }
      const refused = await limiter.consume("presale_sponsor_exec", alice);
      assert.equal(refused.allowed, false);
      assert.equal(refused.retryAfterSeconds, 30, "Retry-After runs to the next UTC midnight");
      assert.equal((await limiter.consume("presale_sponsor_exec", bob)).allowed, true);

      // A new UTC day is a new budget, whenever in the previous day it was spent.
      now = new Date("2026-10-03T00:00:00.000Z");
      assert.equal((await limiter.consume("presale_sponsor_exec", alice)).allowed, true);
      const windows = await pool.query<{ started: Date; expires: Date }>(
        `SELECT window_started_at AS started, expires_at AS expires FROM mission_control_rate_limit_windows
         WHERE policy_name = 'presale_sponsor_exec' ORDER BY window_started_at`,
      );
      assert.deepEqual(
        [...new Set(windows.rows.map((row) => `${row.started.toISOString()}..${row.expires.toISOString()}`))],
        ["2026-10-02T00:00:00.000Z..2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z..2026-10-04T00:00:00.000Z"],
      );

      // Every presale bucket trips at its configured limit, for its subject scope.
      now = new Date("2026-10-04T08:00:00.000Z");
      // `attemptId`: the wrong-signature count is keyed by a reservation (review H2).
      const subject = { accountId: "did:privy:presale-carol", apiKeyId: "agent-key-1", ip: "198.51.100.41", attemptId: "00000000-0000-4000-8000-000000000001" };
      for (const bucket of PRESALE_RATE_BUCKETS) {
        const limit = DEFAULT_RATE_POLICIES[bucket].windows[0]?.limit ?? 0;
        for (let request = 0; request < limit; request += 1) {
          assert.equal((await limiter.consume(bucket, subject)).allowed, true, bucket);
        }
        assert.equal((await limiter.consume(bucket, subject)).allowed, false, bucket);
      }
      // An agent API key without an account has its own allowlist budget.
      assert.equal((await limiter.consume("presale_allowlist", { apiKeyId: "agent-key-1" })).allowed, true);

      const subjects = await pool.query(
        "SELECT subject_hash FROM mission_control_rate_limit_windows WHERE policy_name LIKE 'presale\\_%'",
      );
      assert.doesNotMatch(JSON.stringify(subjects.rows), /did:privy|agent-key|198\.51\.100/);
    } finally {
      await pool.end();
    }
  },
);

test(
  "peek reads a bucket's budget without consuming it: the sponsor route's executed-today check",
  { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    let now = new Date("2026-10-05T21:00:00.000Z");
    const limiter = new PostgresRateLimitEnforcer({ clock: () => new Date(now), pool, subjectPepper: pepper });
    const dave = { accountId: "did:privy:presale-dave" };
    try {
      await migrateDatabase(pool);
      const fresh = await limiter.peek("presale_sponsor_exec", dave);
      assert.deepEqual([fresh.allowed, fresh.retryAfterSeconds], [true, 0], "an untouched bucket has room");
      for (let request = 0; request < 99; request += 1) await limiter.consume("presale_sponsor_exec", dave);
      for (let read = 0; read < 5; read += 1) {
        assert.equal((await limiter.peek("presale_sponsor_exec", dave)).allowed, true, "ninety-nine leave one, however often read");
      }
      assert.equal((await limiter.consume("presale_sponsor_exec", dave)).allowed, true, "peeking consumed nothing");
      const full = await limiter.peek("presale_sponsor_exec", dave);
      assert.deepEqual([full.allowed, full.retryAfterSeconds], [false, 3 * 3_600], "full until the next UTC midnight");
      const counts = await pool.query<{ request_count: number }>(
        "SELECT request_count FROM mission_control_rate_limit_windows WHERE policy_name = 'presale_sponsor_exec' AND window_started_at = '2026-10-05T00:00:00Z'",
      );
      assert.deepEqual(counts.rows.map((row) => row.request_count), [100]);
      now = new Date("2026-10-06T00:00:00.000Z");
      assert.equal((await limiter.peek("presale_sponsor_exec", dave)).allowed, true, "a new UTC day has room");
    } finally {
      await pool.end();
    }
  },
);
