import assert from "node:assert/strict";
import test from "node:test";

import { migrateDatabase, resetDatabase } from "./migrations.ts";
import { createPool, createRuntimePool } from "./pool.ts";
import { recordStatements } from "../../../test/fixtures/modules/database/testing.ts";
import { autocommitRead, autocommitWrite, withTransaction } from "./transaction.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const settings = {
  connectionTimeoutMs: 2_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 200,
  max: 4,
  statementTimeoutMs: 1_500,
};

test("runtime transactions carry their own server-side timeouts", { skip }, async () => {
  assert.ok(databaseUrl);
  const pool = createRuntimePool(databaseUrl, settings);
  try {
    const inside = await withTransaction(pool, (transaction) =>
      Promise.all([
        transaction.read<{ statement_timeout: string }>("SHOW statement_timeout"),
        transaction.read<{ lock_timeout: string }>("SHOW lock_timeout"),
        transaction.read<{ idle_in_transaction_session_timeout: string }>(
          "SHOW idle_in_transaction_session_timeout",
        ),
      ]),
    );
    assert.equal(inside[0].rows[0]?.statement_timeout, "1500ms");
    assert.equal(inside[1].rows[0]?.lock_timeout, "200ms");
    assert.equal(inside[2].rows[0]?.idle_in_transaction_session_timeout, "5s");

    // SET LOCAL ends with the transaction, so a pooled connection is clean.
    const outside = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
    assert.equal(outside.rows[0]?.statement_timeout, "0");

    await assert.rejects(
      withTransaction(pool, (transaction) => transaction.read("SELECT pg_sleep(3)")),
      { code: "57014" },
    );
  } finally {
    await pool.end();
  }
});

test("lock timeouts and serialization failures retry with a bounded budget", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const pool = createRuntimePool(databaseUrl, settings);
  try {
    await admin.query("DROP TABLE IF EXISTS runtime_retry_probe");
    await admin.query("CREATE TABLE runtime_retry_probe (id INT PRIMARY KEY, value INT NOT NULL)");
    await admin.query("INSERT INTO runtime_retry_probe VALUES (1, 0)");

    // Hold the row lock past one lock_timeout, then release it.
    const holder = await admin.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT * FROM runtime_retry_probe WHERE id = 1 FOR UPDATE");
    const release = setTimeout(() => void holder.query("COMMIT").then(() => holder.release()), 350);

    let attempts = 0;
    const locked = await withTransaction(
      pool,
      async (transaction) => {
        attempts += 1;
        return transaction.read<{ value: number }>(
          "SELECT value FROM runtime_retry_probe WHERE id = 1 FOR UPDATE",
        );
      },
      { retry: { attempts: 6, baseDelayMs: 100, maxDelayMs: 200 } },
    );
    clearTimeout(release);
    assert.equal(locked.rows[0]?.value, 0);
    assert.ok(attempts >= 2, `expected a lock_timeout retry, saw ${attempts} attempt(s)`);

    // Without retry, the same lock timeout surfaces as 55P03.
    const blocker = await admin.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT * FROM runtime_retry_probe WHERE id = 1 FOR UPDATE");
      await assert.rejects(
        withTransaction(pool, (transaction) =>
          transaction.read("SELECT value FROM runtime_retry_probe WHERE id = 1 FOR UPDATE"),
        ),
        { code: "55P03" },
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    // Concurrent SERIALIZABLE read-modify-writes of one row: the losers fail
    // with 40001 and succeed on retry, so no increment is lost.
    await migrateDatabase(admin);
    await admin.query(
      `INSERT INTO mission_control_callsign_attempt_limits
         (scope_key, window_started_at, attempt_count, updated_at)
       VALUES ('retry-probe', NOW(), 1, NOW())`,
    );
    let serializationAttempts = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withTransaction(
          pool,
          async (transaction) => {
            serializationAttempts += 1;
            const current = await transaction.read<{ attempt_count: number }>(
              `SELECT attempt_count FROM mission_control_callsign_attempt_limits
               WHERE scope_key = 'retry-probe'`,
            );
            await transaction.forModule("profile").write(
              "mission_control_callsign_attempt_limits",
              `UPDATE mission_control_callsign_attempt_limits
               SET attempt_count = $1 WHERE scope_key = 'retry-probe'`,
              [(current.rows[0]?.attempt_count ?? 0) + 1],
            );
          },
          {
            isolationLevel: "SERIALIZABLE",
            retry: { attempts: 10, baseDelayMs: 5, maxDelayMs: 80 },
          },
        ),
      ),
    );
    const final = await admin.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM mission_control_callsign_attempt_limits
       WHERE scope_key = 'retry-probe'`,
    );
    assert.equal(final.rows[0]?.attempt_count, 9);
    assert.ok(serializationAttempts > 8, "at least one transaction retried after 40001");
  } finally {
    await admin.query("DROP TABLE IF EXISTS runtime_retry_probe");
    await Promise.all([admin.end(), pool.end()]);
  }
});

test("a failed operation rolls back and returns a clean connection", { skip }, async () => {
  assert.ok(databaseUrl);
  const pool = createRuntimePool(databaseUrl, { ...settings, max: 1 });
  try {
    await assert.rejects(
      withTransaction(pool, async (transaction) => {
        await transaction.read("SELECT 1");
        throw new Error("application failure");
      }),
      /application failure/,
    );
    const status = await withTransaction(pool, (transaction) =>
      transaction.read<{ in_transaction: boolean }>(
        "SELECT now() = statement_timestamp() AS in_transaction",
      ),
    );
    assert.equal(status.rows.length, 1, "the single pooled connection is usable again");
  } finally {
    await pool.end();
  }
});

test("a backend killed between statements rejects the transaction without crashing", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 1 });
  const pool = createRuntimePool(databaseUrl, settings);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => void uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await assert.rejects(
      withTransaction(pool, async (transaction) => {
        const backend = await transaction.read<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await admin.query("SELECT pg_terminate_backend($1)", [backend.rows[0]?.pid]);
        // Let the FATAL notice and socket close arrive while no query is active.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await transaction.read("SELECT 1");
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(uncaught, [], "no uncaught 'error' event escaped the lent client");
    const after = await withTransaction(pool, (transaction) =>
      transaction.read<{ ok: number }>("SELECT 1 AS ok"),
    );
    assert.equal(after.rows[0]?.ok, 1, "the pool recovers with a fresh connection");
  } finally {
    process.off("uncaughtException", onUncaught);
    await Promise.all([admin.end(), pool.end()]);
  }
});

test("an error swallowed inside the transaction cannot be reported as committed", { skip }, async () => {
  assert.ok(databaseUrl);
  const pool = createRuntimePool(databaseUrl, settings);
  try {
    await assert.rejects(
      withTransaction(pool, async (transaction) => {
        await transaction.read("SELECT 1 / 0").catch(() => undefined);
        return "looks fine";
      }),
      /instead of COMMIT/,
    );
  } finally {
    await pool.end();
  }
});

test("autocommit writes are guarded single statements that shed timed-out connections", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const pool = createRuntimePool(databaseUrl, { ...settings, max: 1 });
  const backendPid = async () =>
    (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
  try {
    await migrateDatabase(admin);
    await admin.query(
      `INSERT INTO mission_control_callsign_attempt_limits
         (scope_key, window_started_at, attempt_count, updated_at)
       VALUES ('autocommit-probe', NOW(), 1, NOW())`,
    );

    await assert.rejects(
      autocommitWrite(
        pool,
        "session",
        "mission_control_callsign_attempt_limits" as never,
        "DELETE FROM mission_control_callsign_attempt_limits",
      ),
      /cannot write/,
    );
    await assert.rejects(
      autocommitWrite(
        pool,
        "profile",
        "mission_control_callsign_attempt_limits",
        "DELETE FROM mission_control_profiles",
      ),
      /targets "mission_control_profiles"/,
    );

    const pid = await backendPid();
    const updated = await autocommitWrite<"profile", { attempt_count: number }>(
      pool,
      "profile",
      "mission_control_callsign_attempt_limits",
      `UPDATE mission_control_callsign_attempt_limits
       SET attempt_count = attempt_count + 1
       WHERE scope_key = $1
       RETURNING attempt_count`,
      ["autocommit-probe"],
    );
    assert.equal(updated.rows[0]?.attempt_count, 2);
    // Committed on its own: another connection sees it at once.
    const seen = await admin.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM mission_control_callsign_attempt_limits
       WHERE scope_key = 'autocommit-probe'`,
    );
    assert.equal(seen.rows[0]?.attempt_count, 2);

    // A server error ends the implicit transaction; the connection is reused.
    await assert.rejects(
      autocommitWrite(
        pool,
        "profile",
        "mission_control_callsign_attempt_limits",
        `UPDATE mission_control_callsign_attempt_limits
         SET attempt_count = 31
         WHERE scope_key = $1`,
        ["autocommit-probe"],
      ),
      { code: "23514" },
    );
    assert.equal(await backendPid(), pid);

    // A statement stuck past the pool's statement budget fails on the client,
    // and its connection is destroyed instead of being handed to the next caller.
    const holder = await admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT * FROM mission_control_callsign_attempt_limits
         WHERE scope_key = 'autocommit-probe' FOR UPDATE`,
      );
      const started = performance.now();
      await assert.rejects(
        autocommitWrite(
          pool,
          "profile",
          "mission_control_callsign_attempt_limits",
          `UPDATE mission_control_callsign_attempt_limits
           SET updated_at = NOW()
           WHERE scope_key = $1`,
          ["autocommit-probe"],
        ),
        /timeout/i,
      );
      const waited = performance.now() - started;
      assert.ok(
        waited >= settings.statementTimeoutMs - 50 && waited < settings.statementTimeoutMs + 1_000,
        `timed out after ${Math.round(waited)} ms`,
      );
      assert.equal(pool.totalCount, 0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    assert.notEqual(await backendPid(), pid);
  } finally {
    await admin.query(
      "DELETE FROM mission_control_callsign_attempt_limits WHERE scope_key = 'autocommit-probe'",
    );
    await Promise.all([admin.end(), pool.end()]);
  }
});

test("autocommit reads send one statement, round-trip values, and shed timed-out connections", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const pool = createRuntimePool(databaseUrl, { ...settings, max: 1 });
  const statements = recordStatements(pool);
  const backendPid = async () =>
    (await autocommitRead<{ pid: number }>(pool, "profile", "SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
  try {
    await migrateDatabase(admin);
    const at = new Date("2026-09-25T06:00:00.123Z");
    const before = statements.length;
    const echoed = await autocommitRead<{
      at: Date;
      count: string;
      flags: boolean[];
      missing: null;
      payload: { crew: number; tags: string[] };
      text: string;
    }>(
      pool,
      "profile",
      `SELECT $1::text AS text, $2::bigint AS count, $3::timestamptz AS at,
              $4::jsonb AS payload, $5::boolean[] AS flags, $6::text AS missing`,
      ["pilot'; DROP TABLE x; --", "9007199254740993", at, { crew: 7, tags: ["a"] }, [true, false], null],
    );
    assert.deepEqual(echoed.rows, [{
      at,
      count: "9007199254740993",
      flags: [true, false],
      missing: null,
      payload: { crew: 7, tags: ["a"] },
      text: "pilot'; DROP TABLE x; --",
    }]);
    assert.deepEqual(statements.slice(before).map((text) => text.trim().split(/\s+/, 1)[0]), ["SELECT"]);

    // Outside a transaction: no SET LOCAL ran, so the server's own default applies.
    const timeout = await autocommitRead<{ statement_timeout: string }>(
      pool,
      "profile",
      "SHOW statement_timeout",
    );
    assert.equal(timeout.rows[0]?.statement_timeout, "0");

    await assert.rejects(
      autocommitRead(pool, "profile", "DELETE FROM mission_control_seasons"),
      /only accepts SELECT or SHOW/,
    );
    await assert.rejects(
      autocommitRead(pool, "season", "SELECT * FROM mission_control_seasons FOR UPDATE"),
      /cannot take locks/,
    );
    const seasons = await admin.query("SELECT season_id FROM mission_control_seasons");
    assert.equal(seasons.rows.length, 1, "nothing was sent");

    // A server error ends the implicit transaction; the connection is reused.
    const pid = await backendPid();
    await assert.rejects(autocommitRead(pool, "profile", "SELECT 1 / 0"), { code: "22012" });
    assert.equal(await backendPid(), pid);

    // A read slower than the statement budget fails on the client after one
    // budget (it is not resent) and its connection is destroyed.
    const sent = statements.length;
    const started = performance.now();
    await assert.rejects(
      autocommitRead(pool, "profile", "SELECT pg_sleep(3)"),
      /timeout/i,
    );
    const waited = performance.now() - started;
    assert.ok(
      waited >= settings.statementTimeoutMs - 50 && waited < settings.statementTimeoutMs + 1_000,
      `timed out after ${Math.round(waited)} ms`,
    );
    assert.equal(statements.length - sent, 1, "a timed-out read is not resent");
    assert.equal(pool.totalCount, 0);
    assert.notEqual(await backendPid(), pid);
  } finally {
    await Promise.all([admin.end(), pool.end()]);
  }
});

test("a backend killed mid-read rejects that read without crashing", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 1 });
  const pool = createRuntimePool(databaseUrl, { ...settings, max: 1 });
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => void uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    const pid = (await autocommitRead<{ pid: number }>(pool, "profile", "SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    // Handle the rejection before the kill: it can land before the admin
    // query's reply, and an unhandled rejection would fail the test run.
    const rejected = assert.rejects(
      autocommitRead(pool, "profile", "SELECT pg_sleep(1)"),
      { code: "57P01" },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await rejected;
    assert.equal(pool.totalCount, 0, "the terminated client is destroyed, not pooled");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(uncaught, [], "no uncaught 'error' event escaped the lent client");

    const after = await autocommitRead<{ ok: number; pid: number }>(
      pool,
      "profile",
      "SELECT 1 AS ok, pg_backend_pid() AS pid",
    );
    assert.equal(after.rows[0]?.ok, 1, "the pool recovers with a fresh connection");
    assert.notEqual(after.rows[0]?.pid, pid);
  } finally {
    process.off("uncaughtException", onUncaught);
    await Promise.all([admin.end(), pool.end()]);
  }
});

test("worker release decisions are append-only and outside a campaign reset's reach", { skip }, async () => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  try {
    await migrateDatabase(owner);
    const applied = (
      await owner.query<{ name: string }>(
        "SELECT name FROM mission_control_schema_migrations ORDER BY name",
      )
    ).rows.map(({ name }) => name);
    const digest = "cd".repeat(32);
    const {
      rows: [decision],
    } = await owner.query<{ id: string }>(
      `INSERT INTO blast_worker_release_gate_checks
       (network, identity_digest, check_name, passed, evidence)
       VALUES ('mainnet', $1, 'worker-host', TRUE, 'host provisioned') RETURNING id`,
      [digest],
    );
    await owner.query("INSERT INTO mission_control_seasons (season_id) VALUES ('reset-probe')");

    assert.deepEqual(await resetDatabase(owner), applied);
    assert.deepEqual(
      (await owner.query("SELECT season_id FROM mission_control_seasons ORDER BY season_id")).rows,
      [{ season_id: "season-zero" }],
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT passed, evidence FROM blast_worker_release_gate_checks WHERE id = $1",
          [decision.id],
        )
      ).rows,
      [{ passed: true, evidence: "host provisioned" }],
    );
    await assert.rejects(
      owner.query(
        "UPDATE blast_worker_release_gate_checks SET passed = FALSE WHERE id = $1",
        [decision.id],
      ),
      { code: "23514", constraint: "mission_control_launchpad_release_gate_checks_append_only" },
    );
    await assert.rejects(owner.query("TRUNCATE blast_worker_release_gate_checks"), {
      code: "23514",
    });
    const {
      rows: [revocation],
    } = await owner.query<{ id: string }>(
      `INSERT INTO blast_worker_release_gate_checks
       (network, identity_digest, check_name, passed, evidence)
       VALUES ('mainnet', $1, 'worker-host', FALSE, 'host rebuilt') RETURNING id`,
      [digest],
    );
    assert.ok(BigInt(revocation.id) > BigInt(decision.id));
  } finally {
    await owner.end();
  }
});

test("presale release gate records are append-only, even for the table owner: a revocation is a new row", { skip }, async () => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  try {
    await migrateDatabase(owner);
    const digest = "ab".repeat(32);
    const { rows: inserted } = await owner.query<{ id: string }>(
      `INSERT INTO presale_release_gate_checks (network, identity_digest, check_name, passed, evidence)
       VALUES ('mainnet', $1, 'worker-host', TRUE, 'host provisioned'),
              ('mainnet', $1, 'worker-host', FALSE, 'host rebuilt')
       RETURNING id`,
      [digest],
    );
    assert.equal(inserted.length, 2, "recording and revoking both append");
    for (const statement of [
      "UPDATE presale_release_gate_checks SET passed = TRUE WHERE identity_digest = $1",
      "UPDATE presale_release_gate_checks SET evidence = 'rewritten' WHERE identity_digest = $1",
      "DELETE FROM presale_release_gate_checks WHERE identity_digest = $1",
    ]) {
      await assert.rejects(owner.query(statement, [digest]), { code: "23514", constraint: "presale_release_gate_checks_append_only" }, statement);
    }
    await assert.rejects(owner.query("TRUNCATE presale_release_gate_checks"), { code: "23514" });
    const { rows } = await owner.query<{ passed: boolean; evidence: string }>(
      "SELECT passed, evidence FROM presale_release_gate_checks WHERE identity_digest = $1 ORDER BY id",
      [digest],
    );
    assert.deepEqual(rows, [
      { passed: true, evidence: "host provisioned" },
      { passed: false, evidence: "host rebuilt" },
    ]);
  } finally {
    await owner.end();
  }
});

test("prepared autocommit reads reuse plans, isolate parameters, and retain timeout/read-only guards", { skip }, async () => {
  assert.ok(databaseUrl);
  const pool = createRuntimePool(databaseUrl, { ...settings, max: 1, statementTimeoutMs: 100 });
  try {
    const sql = "SELECT $1::text AS account, $2::bigint::text AS balance";
    for (let i = 0; i < 10; i++) {
      const result = await autocommitRead(pool, "social", sql, [`account-${i}`, String(9007199254740993n + BigInt(i))], { prepare: true });
      assert.deepEqual(result.rows, [{ account: `account-${i}`, balance: String(9007199254740993n + BigInt(i)) }]);
    }
    const plans = await pool.query("SELECT statement, generic_plans::int FROM pg_prepared_statements");
    assert.equal(plans.rows.length, 1, "one server-side plan, not a new statement per account");
    assert.equal(plans.rows[0].statement, sql);
    assert.ok(plans.rows[0].generic_plans > 0, "repeated reads avoid replanning");
    assert.deepEqual((await autocommitRead(pool, "social", sql, ["array", "0"], { prepare: true, rowMode: "array" })).rows, [["array", "0"]]);
    await assert.rejects(autocommitRead(pool, "social", "DELETE FROM social_accounts", [], { prepare: true }), /only accepts SELECT or SHOW/);
    await assert.rejects(autocommitRead(pool, "social", "SELECT pg_advisory_lock(1)", [], { prepare: true }), /cannot take locks/);
    await pool.query("CREATE TEMP TABLE prepared_values(key text PRIMARY KEY, balance int)");
    await pool.query("INSERT INTO prepared_values VALUES ('wallet', 1)");
    const balanceSql = "SELECT balance FROM prepared_values WHERE key = $1";
    assert.equal((await autocommitRead(pool, "social", balanceSql, ["wallet"], { prepare: true })).rows[0].balance, 1);
    await pool.query("UPDATE prepared_values SET balance = 7");
    await pool.query("ALTER TABLE prepared_values ADD COLUMN label text");
    assert.equal((await autocommitRead(pool, "social", balanceSql, ["wallet"], { prepare: true })).rows[0].balance, 7, "plans do not cache balances and survive additive schema changes");
    const before = (await pool.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await assert.rejects(autocommitRead(pool, "social", "SELECT pg_sleep($1)", [1], { prepare: true }), /timeout/i);
    assert.notEqual((await pool.query("SELECT pg_backend_pid() pid")).rows[0].pid, before);
    assert.deepEqual((await autocommitRead(pool, "social", sql, ["new-connection", "3"], { prepare: true })).rows, [{account: "new-connection", balance: "3"}]);
  } finally {
    await pool.end();
  }
});


test("whole-transaction cancellation destroys the connection and prevents a later commit", { skip }, async () => {
  assert.ok(databaseUrl);
  const pool = createRuntimePool(databaseUrl, settings);
  try {
    const controller = new AbortController();
    const operation = withTransaction(pool, async (transaction) => {
      await transaction.read("SELECT pg_sleep(3)");
      assert.fail("cancelled statement cannot reach mutation");
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("operation budget exceeded")), 50);
    await assert.rejects(operation);
    assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value, 1);
  } finally { await pool.end(); }
});
