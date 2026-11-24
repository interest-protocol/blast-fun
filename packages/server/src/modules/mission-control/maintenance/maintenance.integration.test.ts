import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createPool,
  migrateDatabase,
} from "@blast/core/modules/database/admin.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import {
  CLEANUP_TARGETS,
  deleteExpiredBatch,
} from "@blast/server/modules/mission-control/maintenance/repository.ts";
import { runCleanup } from "@blast/server/modules/mission-control/maintenance/service.ts";

process.env.MISSION_CONTROL_METRICS = "off";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const NOW = new Date("2026-09-25T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PROFILE_ID = "e0000000-0000-4000-8000-000000000025";

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function hex(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function uuid(index: number): string {
  return `f0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

test(
  "cleanup removes only expired rows and keeps everything still referenced",
  {
    skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
  },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });

    async function labels(table: string, column: string): Promise<string[]> {
      const result = await pool.query<{ label: string }>(
        `SELECT ${column} AS label FROM ${table} ORDER BY 1`,
      );
      return result.rows.map((row) => row.label);
    }

    try {
      await migrateDatabase(pool);
      await pool.query(
        `INSERT INTO mission_control_profiles (
           profile_id, privy_did, x_subject, sui_address,
           provider_wallet_reference, callsign, disclosure_version,
           disclosure_accepted_at
         ) VALUES ($1, 'did:privy:cleanup', 'x-cleanup', $2, 'wallet-cleanup',
                   'cleanup_pilot', 'automatic-disclosure-v1', $3)`,
        [PROFILE_ID, `0x${"25".repeat(32)}`, at(-60 * DAY)],
      );

      async function seedExpiringAuth() {
        // Rate-limit windows: gone an hour after expiry.
        const windows: Array<[string, number]> = [
          ["expired-2h-a", -2 * HOUR],
          ["expired-2h-b", -2 * HOUR],
          ["expired-2h-c", -3 * HOUR],
          ["expired-30m", -30 * MINUTE],
          ["live", 30 * MINUTE],
        ];
        for (const [label, expiresIn] of windows) {
          await pool.query(
            `INSERT INTO mission_control_rate_limit_windows (
               policy_name, policy_version, subject_hash, window_seconds,
               window_started_at, request_count, expires_at
             ) VALUES ($1, 1, $2, 3600, $3, 4, $4)`,
            [label, hex(label), at(expiresIn - HOUR), at(expiresIn)],
          );
        }

        // OAuth states: consumed or not, gone an hour after expiry.
        const states: Array<[string, number, boolean]> = [
          ["expired-2h", -2 * HOUR, false],
          ["consumed-expired-2h", -2 * HOUR, true],
          ["expired-30m", -30 * MINUTE, false],
          ["live", 5 * MINUTE, false],
        ];
        for (const [label, expiresIn, consumed] of states) {
          await pool.query(
            `INSERT INTO mission_control_oauth_states (
               state_hash, nonce_hash, pkce_verifier_hash, origin, callback_url,
               issued_at, expires_at, consumed_at
             ) VALUES ($1, $2, $2, 'https://blast.fun', $3, $4, $5, $6)`,
            [
              hex(label),
              hex(`nonce-${label}`),
              `https://blast.fun/${label}`,
              at(expiresIn - 10 * MINUTE),
              at(expiresIn),
              consumed ? at(expiresIn - 5 * MINUTE) : null,
            ],
          );
        }

        // Wallet challenges: unconsumed ones go an hour after expiry; consumed
        // proofs stay until any admission attempt they prove has expired.
        const challenges: Array<[number, string, number, boolean]> = [
          [1, "onboarding", -2 * HOUR, false],
          [2, "onboarding", -30 * MINUTE, false],
          [3, "onboarding", -2 * HOUR, true],
          [4, "onboarding", -26 * HOUR, true],
          [5, "link_wallet", -2 * HOUR, true],
          [6, "link_wallet", -26 * HOUR, true],
          [7, "onboarding", 3 * MINUTE, false],
        ];
        for (const [index, action, expiresIn, consumed] of challenges) {
          const contextKind = action === "onboarding" ? "attempt" : "account";
          await pool.query(
            `INSERT INTO mission_control_wallet_challenges (
               challenge_id, action, wallet_address, origin, context_kind, context_id,
               nonce_hash, message_hash, issued_at, expires_at, consumed_at
             ) VALUES ($1, $2, $3, 'https://blast.fun', $4, $5, $6, $6, $7, $8, $9)`,
            [
              uuid(index),
              action,
              `0x${"ab".repeat(32)}`,
              contextKind,
              `context-${index}`,
              hex(`challenge-${index}`),
              at(expiresIn - 5 * MINUTE),
              at(expiresIn),
              consumed ? at(expiresIn - MINUTE) : null,
            ],
          );
        }
      }
      await seedExpiringAuth();

      // Admission failures count for ten minutes; kept an hour past that.
      for (const [index, occurredIn] of [
        [11, -2 * HOUR],
        [12, -80 * MINUTE],
        [13, -65 * MINUTE],
        [14, -5 * MINUTE],
      ] as const) {
        await pool.query(
          `INSERT INTO mission_control_admission_failures (failure_id, subject_hmac, occurred_at)
           VALUES ($1, $2, $3)`,
          [uuid(index), hex(`subject-${index}`), at(occurredIn)],
        );
      }

      // Admission attempts: expired and unreferenced go; a completed attempt
      // stays because completion idempotency references it.
      await pool.query(
        `INSERT INTO mission_control_invitation_codes (
           code_id, season_id, lookup_key_version, lookup_hmac,
           encrypted_display, encryption_iv, encryption_tag, encryption_key_version
         ) VALUES ($1, 'season-zero', 'v1', $2, 'display', 'iv', 'tag', 'v1')`,
        [uuid(20), hex("cleanup-code")],
      );
      for (const [index, expiresIn] of [
        [21, -2 * HOUR],
        [22, -2 * HOUR],
        [23, -30 * MINUTE],
        [24, 12 * HOUR],
      ] as const) {
        await pool.query(
          `INSERT INTO mission_control_admission_attempts (
             attempt_id, admission_token_hmac, candidate_code_id, created_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            uuid(index),
            hex(`attempt-${index}`),
            uuid(20),
            at(expiresIn - DAY),
            at(expiresIn),
          ],
        );
      }
      await pool.query(
        `INSERT INTO mission_control_completion_idempotency (
           idempotency_key_hash, request_hash, attempt_id, profile_id, completed_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          hex("idempotency"),
          hex("request"),
          uuid(22),
          PROFILE_ID,
          at(-20 * HOUR),
        ],
      );

      async function seedMemberSessions() {
        // Member sessions: kept 30 days past revocation or idle expiry.
        const sessions: Array<[number, number, number | null]> = [
          [31, -31 * DAY, null],
          [32, -29 * DAY, null],
          [33, 3 * DAY, -31 * DAY],
          [34, 3 * DAY, -29 * DAY],
          [35, 6 * DAY, null],
        ];
        for (const [index, idleIn, revokedIn] of sessions) {
          const created = at(Math.min(idleIn, revokedIn ?? idleIn) - 10 * DAY);
          await pool.query(
            `INSERT INTO mission_control_member_sessions (
               session_id, token_hash, profile_id, scope, created_at, last_seen_at,
               idle_expires_at, absolute_expires_at, revoked_at
             ) VALUES ($1, $2, $3, 'member', $4, $4, $5, $6, $7)`,
            [
              uuid(index),
              hex(`session-${index}`),
              PROFILE_ID,
              created,
              at(idleIn),
              at(idleIn + DAY),
              revokedIn === null ? null : at(revokedIn),
            ],
          );
        }
      }
      await seedMemberSessions();

      // Callsign attempt limits: a passed one-minute window is dead weight.
      for (const [label, startedIn] of [
        ["stale-2h", -2 * HOUR],
        ["recent-30m", -30 * MINUTE],
        ["current", -10_000],
      ] as const) {
        await pool.query(
          `INSERT INTO mission_control_callsign_attempt_limits (
             scope_key, window_started_at, attempt_count, updated_at
           ) VALUES ($1, $2, 3, $2)`,
          [label, at(startedIn)],
        );
      }

      // Launchpad telemetry: kept for the reporting policy's 90 days. A first
      // view goes with its whole period (UTC day); the cutoff is 2026-06-27.
      for (const [visitor, periodStart] of [
        ["11111111-1111-4111-8111-111111111111", "2026-06-26"],
        ["22222222-2222-4222-8222-222222222222", "2026-06-27"],
        ["33333333-3333-4333-8333-333333333333", "2026-09-25"],
      ] as const) {
        await pool.query(
          `INSERT INTO mission_control_launchpad_coin_views (
             period_start, visitor_id, launch_id, surface, viewed_at
           ) VALUES ($1::date, $2, $3, 'coin-page', $1::date::timestamp AT TIME ZONE 'UTC')`,
          [periodStart, visitor, `0x${"a1".repeat(32)}`],
        );
      }
      for (const [digest, completedIn] of [
        ["4pFwTqfQ3m1kVg7nN8hQ9hXg5Y5y7p8E2yR6bW3sJmGv", -91 * DAY],
        ["9xQ3rT7vW2yZ5bC8dF1gH4jK6mN9pR2sT5uV8wX1yZ3a", -89 * DAY],
      ] as const) {
        await pool.query(
          `INSERT INTO mission_control_launchpad_outcomes (
             tx_digest, event_seq, kind, checkpoint, launch_id, sender_wallet, visitor_id, completed_at
           ) VALUES ($1, 0, 'buy', 1, $2, $3, NULL, $4)`,
          [
            digest,
            `0x${"a1".repeat(32)}`,
            `0x${"c0".repeat(32)}`,
            at(completedIn),
          ],
        );
      }
      // Outcome commitments a report never decided: gone after the window (one hour by default).
      for (const [visitor, committedIn] of [
        ["44444444-4444-4444-8444-444444444444", -61 * MINUTE],
        ["55555555-5555-4555-8555-555555555555", -59 * MINUTE],
      ] as const) {
        await pool.query(
          `INSERT INTO mission_control_launchpad_outcome_commitments (
             tx_digest, visitor_id, kind, launch_id, committed_at
           ) VALUES ($1, $2, 'buy', $3, $4)`,
          [
            "4pFwTqfQ3m1kVg7nN8hQ9hXg5Y5y7p8E2yR6bW3sJmGv",
            visitor,
            `0x${"a1".repeat(32)}`,
            at(committedIn),
          ],
        );
      }

      // Presale outcomes (0043) mirror the launchpad's: kept for the reporting
      // policy's 90 days; an undecided commitment goes after the same window.
      for (const [digest, completedIn] of [
        ["presaWipeExpiredoutcomezzzzzzzzzzzzzzzzzzzzz", -91 * DAY],
        ["presaWipeFreshoutcomezzzzzzzzzzzzzzzzzzzzzzz", -89 * DAY],
      ] as const) {
        await pool.query(
          `INSERT INTO presale_outcomes (
             tx_digest, event_seq, presale_id, sender_wallet, checkpoint, completed_at,
             visitor_id, visitor_link, privy_did
           ) VALUES ($1, 0, $2, $3, 1, $4, '66666666-6666-4666-8666-666666666666', 'signed_commitment', 'did:privy:cleanup')`,
          [
            digest,
            `0x${"7a".repeat(32)}`,
            `0x${"c0".repeat(32)}`,
            at(completedIn),
          ],
        );
      }
      for (const [visitor, committedIn] of [
        ["77777777-7777-4777-8777-777777777777", -61 * MINUTE],
        ["88888888-8888-4888-8888-888888888888", -59 * MINUTE],
      ] as const) {
        await pool.query(
          `INSERT INTO presale_outcome_commitments (tx_digest, visitor_id, presale_id, committed_at)
           VALUES ($1, $2, $3, $4)`,
          [
            "presaWipeCommitmentzzzzzzzzzzzzzzzzzzzzzzzzz",
            visitor,
            `0x${"7a".repeat(32)}`,
            at(committedIn),
          ],
        );
      }

      // Launchpad Wallet Proof challenges: nothing reads one after it
      // expires, spent or not; each goes an hour after expiry.
      const launchpadChallenges: Array<[number, number, boolean]> = [
        [41, -2 * HOUR, false],
        [42, -2 * HOUR, true],
        [43, -30 * MINUTE, true],
        [44, 3 * MINUTE, false],
      ];
      for (const [index, expiresIn, consumed] of launchpadChallenges) {
        await pool.query(
          `INSERT INTO mission_control_launchpad_wallet_challenges (
             challenge_id, action, wallet_address, origin, nonce_hash, message_hash,
             issued_at, expires_at, consumed_at
           ) VALUES ($1, 'social_post', $2, 'https://blast.fun', $3, $3, $4, $5, $6)`,
          [
            uuid(index),
            `0x${"ab".repeat(32)}`,
            hex(`launchpad-challenge-${index}`),
            at(expiresIn - 5 * MINUTE),
            at(expiresIn),
            consumed ? at(expiresIn - MINUTE) : null,
          ],
        );
      }

      const report = await runCleanup(pool, { batchSize: 2, clock: () => NOW });
      assert.equal(report.ok, true);
      assert.equal(report.complete, true);
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(report.tables).map(([table, result]) => [
            table,
            [result.deleted, result.batches],
          ]),
        ),
        {
          mission_control_admission_attempts: [1, 1],
          mission_control_admission_failures: [2, 2],
          mission_control_callsign_attempt_limits: [1, 1],
          mission_control_launchpad_coin_views: [1, 1],
          mission_control_launchpad_outcomes: [1, 1],
          mission_control_launchpad_outcome_commitments: [1, 1],
          mission_control_launchpad_wallet_challenges: [2, 2],
          mission_control_member_sessions: [2, 2],
          mission_control_oauth_states: [2, 2],
          mission_control_rate_limit_windows: [3, 2],
          mission_control_wallet_challenges: [3, 2],
          presale_outcomes: [1, 1],
          presale_outcome_commitments: [1, 1],
        },
      );

      assert.deepEqual(
        await labels("mission_control_rate_limit_windows", "policy_name"),
        ["expired-30m", "live"],
      );
      assert.deepEqual(
        await labels("mission_control_oauth_states", "callback_url"),
        ["https://blast.fun/expired-30m", "https://blast.fun/live"],
      );
      assert.deepEqual(
        await labels("mission_control_wallet_challenges", "context_id"),
        ["context-2", "context-3", "context-5", "context-7"],
      );
      assert.deepEqual(
        await labels("mission_control_admission_failures", "failure_id::text"),
        [uuid(13), uuid(14)],
      );
      assert.deepEqual(
        await labels("mission_control_admission_attempts", "attempt_id::text"),
        [uuid(22), uuid(23), uuid(24)],
      );
      assert.deepEqual(
        await labels(
          "mission_control_completion_idempotency",
          "attempt_id::text",
        ),
        [uuid(22)],
      );
      assert.deepEqual(
        await labels("mission_control_member_sessions", "session_id::text"),
        [uuid(32), uuid(34), uuid(35)],
      );
      assert.deepEqual(
        await labels("mission_control_callsign_attempt_limits", "scope_key"),
        ["current", "recent-30m"],
      );
      assert.deepEqual(
        await labels(
          "mission_control_launchpad_coin_views",
          "period_start::text",
        ),
        ["2026-06-27", "2026-09-25"],
      );
      assert.deepEqual(
        await labels("mission_control_launchpad_outcomes", "tx_digest"),
        ["9xQ3rT7vW2yZ5bC8dF1gH4jK6mN9pR2sT5uV8wX1yZ3a"],
      );
      assert.deepEqual(
        await labels(
          "mission_control_launchpad_outcome_commitments",
          "visitor_id::text",
        ),
        ["55555555-5555-4555-8555-555555555555"],
      );
      assert.deepEqual(
        await labels(
          "mission_control_launchpad_wallet_challenges",
          "challenge_id::text",
        ),
        [uuid(43), uuid(44)],
      );
      assert.deepEqual(await labels("presale_outcomes", "tx_digest"), [
        "presaWipeFreshoutcomezzzzzzzzzzzzzzzzzzzzzzz",
      ]);
      assert.deepEqual(
        await labels("presale_outcome_commitments", "visitor_id::text"),
        ["88888888-8888-4888-8888-888888888888"],
      );
      assert.deepEqual(
        await labels("mission_control_profiles", "profile_id::text"),
        [PROFILE_ID],
      );
      assert.deepEqual(
        await labels("mission_control_invitation_codes", "code_id::text"),
        [uuid(20)],
      );

      // A second run finds nothing and finishes in one batch per table.
      const again = await runCleanup(pool, { batchSize: 2, clock: () => NOW });
      assert.ok(
        Object.values(again.tables).every(
          (result) =>
            result.deleted === 0 && result.batches === 1 && result.complete,
        ),
      );
    } finally {
      await pool
        .query("DELETE FROM presale_outcomes WHERE tx_digest LIKE 'presaWipe%'")
        .catch(() => undefined);
      await pool
        .query(
          "DELETE FROM presale_outcome_commitments WHERE tx_digest LIKE 'presaWipe%'",
        )
        .catch(() => undefined);
      await pool.end();
    }
  },
);

test(
  "a row revived while its batch is being deleted survives",
  {
    skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
  },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    const target = CLEANUP_TARGETS.find(
      (candidate) =>
        candidate.table === "mission_control_callsign_attempt_limits",
    );
    assert.ok(target);
    try {
      await migrateDatabase(pool);
      await pool.query(
        `INSERT INTO mission_control_callsign_attempt_limits (
           scope_key, window_started_at, attempt_count, updated_at
         ) VALUES ('revived', $1, 3, $1)`,
        [at(-2 * HOUR)],
      );
      // A callsign check restarts the stale window and holds the row lock.
      const holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query(
        `UPDATE mission_control_callsign_attempt_limits
         SET window_started_at = $1, attempt_count = 1, updated_at = $1
         WHERE scope_key = 'revived'`,
        [NOW],
      );
      // The batch picks the row from its snapshot (still stale), then waits.
      const deleting = withTransaction(pool, (transaction) =>
        deleteExpiredBatch(transaction, target, NOW, 10),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("COMMIT");
      holder.release();

      assert.equal(await deleting, 0);
      const row = await pool.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM mission_control_callsign_attempt_limits
         WHERE scope_key = 'revived'`,
      );
      assert.deepEqual(row.rows, [{ attempt_count: 1 }]);
    } finally {
      await pool.end();
    }
  },
);

test(
  "the web runtime role the cron runs as can delete expired presale outcomes and commitments",
  {
    skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
  },
  async () => {
    assert.ok(databaseUrl);
    const admin = createPool(databaseUrl, { max: 2 });
    const web = createRuntimePool(
      urlAs(databaseUrl, "blast_web"),
      {
        connectionTimeoutMs: 2_000,
        idleInTransactionMs: 15_000,
        idleTimeoutMs: 1_000,
        lockTimeoutMs: 3_000,
        max: 2,
        statementTimeoutMs: 8_000,
      },
      "maintenance-presale-suite",
    );
    const digest = "presaWipeWebRoezzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    try {
      await migrateDatabase(admin);
      await admin.query(
        `INSERT INTO presale_outcomes (tx_digest, event_seq, presale_id, sender_wallet, checkpoint, completed_at)
         VALUES ($1, 0, $2, $3, 1, $4)`,
        [digest, `0x${"7a".repeat(32)}`, `0x${"c0".repeat(32)}`, at(-91 * DAY)],
      );
      await admin.query(
        `INSERT INTO presale_outcome_commitments (tx_digest, visitor_id, presale_id, committed_at)
         VALUES ($1, '99999999-9999-4999-8999-999999999999', $2, $3)`,
        [digest, `0x${"7a".repeat(32)}`, at(-2 * HOUR)],
      );
      const deleted: Record<string, number> = {};
      for (const target of CLEANUP_TARGETS.filter((candidate) =>
        candidate.table.startsWith("presale_"),
      )) {
        deleted[target.table] = await withTransaction(web, (transaction) =>
          deleteExpiredBatch(transaction, target, NOW, 10),
        );
      }
      assert.deepEqual(deleted, {
        presale_outcomes: 1,
        presale_outcome_commitments: 1,
      });
    } finally {
      await admin
        .query("DELETE FROM presale_outcomes WHERE tx_digest = $1", [digest])
        .catch(() => undefined);
      await admin
        .query("DELETE FROM presale_outcome_commitments WHERE tx_digest = $1", [
          digest,
        ])
        .catch(() => undefined);
      await Promise.all([admin.end(), web.end()]);
    }
  },
);
