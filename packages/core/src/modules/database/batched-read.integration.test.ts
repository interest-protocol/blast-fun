import assert from "node:assert/strict";
import test from "node:test";
import { createPool, createRuntimePool, PARTNER_VERIFIER_POOL_SETTINGS } from "./pool.ts";
import { batchedRead } from "./transaction.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("batched primary reads preserve transaction budgets, rollback and connection hygiene", { skip: databaseUrl ? false : "Disposable PostgreSQL required" }, async (context) => {
  assert.ok(databaseUrl);
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  const settings = { ...PARTNER_VERIFIER_POOL_SETTINGS, max: 1 };
  const pool = createRuntimePool(databaseUrl, settings, "batched-read-test");
  const admin = createPool(databaseUrl, { max: 1 });
  const read = (sql: string, timeouts = {}) => batchedRead(pool, "partner-api-keys", sql, { timeouts: { lockTimeoutMs: 100, ...timeouts } });
  try {
    await admin.query("CREATE TABLE batched_read_guard (value integer)");
    const settingsSql = `SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle,
      current_setting('transaction_read_only') AS readonly`;
    const original = (await pool.query(settingsSql)).rows;
    await context.test("SET LOCAL remains server-enforced and settings do not leak", async () => {
      assert.deepEqual((await read(settingsSql)).rows, [{ statement: "500ms", lock: "100ms", idle: "1s", readonly: "on" }]);
      assert.deepEqual((await pool.query(settingsSql)).rows, original);
      assert.equal((await read("SELECT 7 AS value")).rows[0].value, 7);
    });
    await context.test("a blocked registry table hits the short server lock timeout and recovers", async () => {
      await admin.query("BEGIN; LOCK TABLE batched_read_guard IN ACCESS EXCLUSIVE MODE");
      try { await assert.rejects(read("SELECT * FROM batched_read_guard"), { code: "55P03" }); }
      finally { await admin.query("ROLLBACK"); }
      assert.deepEqual((await read("SELECT * FROM batched_read_guard")).rows, []);
      assert.deepEqual((await pool.query(settingsSql)).rows, original);
    });
    await context.test("server statement timeout aborts the read and rollback leaves a clean session", async () => {
      const before = performance.now();
      await assert.rejects(read("SELECT pg_sleep(1)", { statementTimeoutMs: 35 }), { code: "57014" });
      assert.ok(performance.now() - before < 1_000);
      assert.equal((await read("SELECT 9 AS value")).rows[0].value, 9);
      assert.deepEqual((await pool.query(settingsSql)).rows, original);
    });
    await context.test("a SQL error is rolled back, and SELECT cannot mutate through a function", async () => {
      await assert.rejects(read("SELECT 1 / 0"), { code: "22012" });
      await admin.query(`CREATE FUNCTION batched_read_write() RETURNS integer LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO batched_read_guard VALUES (1); RETURN 1; END $$`);
      await assert.rejects(read("SELECT batched_read_write()"), { code: "25006" });
      assert.deepEqual((await admin.query("SELECT * FROM batched_read_guard")).rows, []);
      assert.deepEqual((await pool.query(settingsSql)).rows, original);
    });
    await context.test("multiple statements, writes and advisory locks are rejected before checkout", async () => {
      for (const sql of ["SELECT 1; COMMIT", "DELETE FROM batched_read_guard", "SELECT pg_advisory_lock(1)", "SELECT * FROM batched_read_guard FOR UPDATE"]) {
        await assert.rejects(read(sql));
      }
      assert.equal((await read("SELECT 11 AS value")).rows[0].value, 11);
    });
    await context.test("client timeout destroys the uncertain connection instead of pooling it", async () => {
      const limited = createRuntimePool(databaseUrl, { ...settings, queryTimeoutMs: 35 }, "batched-client-timeout-test");
      let sleepAttempts = 0;
      limited.on("connect", (client) => {
        client.query = new Proxy(client.query, { apply(target, receiver, args) {
          if (typeof args[0] === "string" && args[0].includes("pg_sleep")) sleepAttempts += 1;
          return Reflect.apply(target, receiver, args);
        } });
      });
      try {
        const firstPid = (await limited.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await assert.rejects(batchedRead(limited, "partner-api-keys", "SELECT pg_sleep(1)"), /timeout/i);
        assert.equal(sleepAttempts, 1, "Client timeouts are load, not dead-socket retries");
        const next = await batchedRead(limited, "partner-api-keys", "SELECT pg_backend_pid() AS pid");
        assert.notEqual(next.rows[0].pid, firstPid);
        assert.equal(limited.waitingCount, 0);
      } finally { await limited.end(); }
    });
  } finally { await pool.end(); await admin.end(); }
});
