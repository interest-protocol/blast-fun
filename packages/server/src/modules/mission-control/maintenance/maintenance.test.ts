import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { assertOwnedWriteStatement } from "@blast/core/modules/database/transaction.ts";
import { TABLE_OWNERSHIP } from "@blast/core/modules/database/modules.ts";
import { CLEANUP_TABLES } from "@blast/core/modules/mission-control/maintenance/contracts.ts";
import { CLEANUP_TARGETS } from "@blast/server/modules/mission-control/maintenance/repository.ts";
import { runCleanup } from "@blast/server/modules/mission-control/maintenance/service.ts";

process.env.MISSION_CONTROL_METRICS = "off";

const NOW = new Date("2026-09-25T12:00:00.000Z");

interface Statement {
  text: string;
  values: readonly unknown[];
}

/** A pool whose DELETEs report rows from a per-table backlog. */
function fakeCleanupPool(
  backlog: Partial<Record<string, number>>,
  failing = new Set<string>(),
) {
  const deletes: Statement[] = [];
  const remaining = new Map(Object.entries(backlog));
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      if (!text.startsWith("DELETE")) {
        return {
          command: text.split(/[\s;]/, 1)[0].toUpperCase(),
          rows: [],
          rowCount: null,
        };
      }
      deletes.push({ text, values });
      const table = /^DELETE FROM (\w+)/.exec(text)?.[1] ?? "";
      if (failing.has(table)) {
        throw Object.assign(new Error(`secret detail about ${table}`), {
          code: "23503",
        });
      }
      const limit = Number(values[0]);
      const available = remaining.get(table) ?? 0;
      const rowCount = Math.min(limit, available);
      remaining.set(table, available - rowCount);
      return { rows: [], rowCount };
    },
    on() {},
    release() {},
    removeListener() {},
  };
  return { deletes, pool: { connect: async () => client } as unknown as Pool };
}

test("cleanup targets write only their owners' expiring tables", () => {
  assert.deepEqual(
    CLEANUP_TARGETS.map((target) => target.table),
    [...CLEANUP_TABLES],
  );
  for (const target of CLEANUP_TARGETS) {
    assert.ok(
      (TABLE_OWNERSHIP[target.module] as readonly string[]).includes(
        target.table,
      ),
      `${target.module} owns ${target.table}`,
    );
    assert.doesNotThrow(() =>
      assertOwnedWriteStatement(
        target.module,
        target.table,
        `DELETE FROM ${target.table}`,
      ),
    );
    for (const parameter of target.parameters(NOW)) {
      assert.ok(
        parameter.getTime() < NOW.getTime(),
        `${target.table} keeps live rows`,
      );
    }
  }
  const protectedTables = [
    "mission_control_campaign_events",
    "mission_control_completion_idempotency",
    "mission_control_operator_actions",
    "mission_control_operator_action_events",
    "mission_control_season_memberships",
  ];
  for (const table of protectedTables) {
    assert.equal((CLEANUP_TABLES as readonly string[]).includes(table), false);
  }
});

test("cutoffs keep each row as long as the code that reads it needs", () => {
  const cutoffs = Object.fromEntries(
    CLEANUP_TARGETS.map((target) => [
      target.table,
      target.parameters(NOW).map((value) => value.toISOString()),
    ]),
  );
  assert.deepEqual(cutoffs, {
    mission_control_admission_attempts: ["2026-09-25T11:00:00.000Z"],
    mission_control_admission_failures: ["2026-09-25T10:50:00.000Z"],
    mission_control_callsign_attempt_limits: ["2026-09-25T10:59:00.000Z"],
    // Launchpad telemetry is kept for the reporting policy's 90 days.
    mission_control_launchpad_coin_views: ["2026-06-27T12:00:00.000Z"],
    mission_control_launchpad_outcomes: ["2026-06-27T12:00:00.000Z"],
    // An outcome commitment never decided goes after the configured window (default one hour).
    mission_control_launchpad_outcome_commitments: ["2026-09-25T11:00:00.000Z"],
    // A launchpad Wallet Proof is consumed by its write before it expires.
    mission_control_launchpad_wallet_challenges: ["2026-09-25T11:00:00.000Z"],
    mission_control_member_sessions: ["2026-08-26T12:00:00.000Z"],
    mission_control_oauth_states: ["2026-09-25T11:00:00.000Z"],
    mission_control_rate_limit_windows: ["2026-09-25T11:00:00.000Z"],
    mission_control_wallet_challenges: [
      "2026-09-25T11:00:00.000Z",
      "2026-09-24T11:00:00.000Z",
    ],
    // Presale outcomes mirror the launchpad's: the reporting policy's 90 days,
    // and an undecided commitment goes after the same window (default one hour).
    presale_outcomes: ["2026-06-27T12:00:00.000Z"],
    presale_outcome_commitments: ["2026-09-25T11:00:00.000Z"],
  });
});

test("cleanup deletes in bounded batches, table by table in turns", async () => {
  const fake = fakeCleanupPool({
    mission_control_member_sessions: 3,
    mission_control_rate_limit_windows: 5,
  });
  const result = await runCleanup(fake.pool, {
    batchSize: 2,
    clock: () => NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.tables).map(([table, value]) => [
        table,
        [value.deleted, value.batches, value.complete],
      ]),
    ),
    {
      mission_control_admission_attempts: [0, 1, true],
      mission_control_admission_failures: [0, 1, true],
      mission_control_callsign_attempt_limits: [0, 1, true],
      mission_control_launchpad_coin_views: [0, 1, true],
      mission_control_launchpad_outcomes: [0, 1, true],
      mission_control_launchpad_outcome_commitments: [0, 1, true],
      mission_control_launchpad_wallet_challenges: [0, 1, true],
      mission_control_member_sessions: [3, 2, true],
      mission_control_oauth_states: [0, 1, true],
      mission_control_rate_limit_windows: [5, 3, true],
      mission_control_wallet_challenges: [0, 1, true],
      presale_outcomes: [0, 1, true],
      presale_outcome_commitments: [0, 1, true],
    },
  );
  // Round one visits every table before round two revisits any.
  assert.deepEqual(
    fake.deletes
      .slice(0, CLEANUP_TABLES.length)
      .map((statement) => /^DELETE FROM (\w+)/.exec(statement.text)?.[1]),
    [...CLEANUP_TABLES],
  );
  for (const statement of fake.deletes) {
    assert.match(
      statement.text,
      /^DELETE FROM (\w+)\s+WHERE ctid = ANY \(ARRAY\(\s+SELECT ctid\s+FROM \1\s+WHERE [\s\S]+LIMIT \$1\s+\)\)\s+AND /,
    );
    assert.equal(statement.values[0], 2);
    assert.doesNotMatch(statement.text, /;/);
  }
});

test("a failing table is reported by label and the others still run", async () => {
  const fake = fakeCleanupPool(
    { mission_control_oauth_states: 1 },
    new Set(["mission_control_admission_attempts"]),
  );
  const result = await runCleanup(fake.pool, { clock: () => NOW });
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.tables.mission_control_admission_attempts, {
    batches: 0,
    complete: false,
    deleted: 0,
    durationMs: result.tables.mission_control_admission_attempts.durationMs,
    error: "23503",
  });
  assert.equal(result.tables.mission_control_oauth_states.deleted, 1);
  assert.equal(result.tables.mission_control_member_sessions.complete, true);
  assert.doesNotMatch(JSON.stringify(result), /secret detail/);
});

test("the time budget stops a run and leaves the rest for the next one", async () => {
  const fake = fakeCleanupPool({ mission_control_rate_limit_windows: 10_000 });
  const result = await runCleanup(fake.pool, { budgetMs: 0, clock: () => NOW });
  assert.equal(fake.deletes.length, 0);
  assert.equal(result.complete, false);
  assert.equal(result.ok, true);
  await assert.rejects(
    runCleanup(fake.pool, { batchSize: 1_001 }),
    /batch size/,
  );
  await assert.rejects(runCleanup(fake.pool, { batchSize: 0 }), /batch size/);
});
