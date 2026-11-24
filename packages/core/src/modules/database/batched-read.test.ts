import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseError, type PoolClient } from "pg";
import { createRuntimePool, PARTNER_VERIFIER_POOL_SETTINGS } from "./pool.ts";
import { batchedRead } from "./transaction.ts";

const complete = [{ command: "BEGIN" }, { command: "SET" }, { command: "SELECT", rows: [{ ok: 1 }] }, { command: "COMMIT" }];

test("batched reads never grant without COMMIT acknowledgement or retry a missing acknowledgement", async (t) => {
  for (const results of [complete.slice(0, -1), [...complete.slice(0, -1), { command: "ROLLBACK" }], { command: "SELECT", rows: [{ ok: 1 }] }]) {
    const pool = createRuntimePool("postgres://localhost:9/unused", PARTNER_VERIFIER_POOL_SETTINGS);
    let checkouts = 0;
    const released: (Error | undefined)[] = [];
    const client = { query: async () => results, on() {}, removeListener() {}, release(error?: Error) { released.push(error); } } as unknown as PoolClient;
    t.mock.method(pool, "connect", async () => { checkouts += 1; return client; });
    try {
      await assert.rejects(batchedRead(pool, "partner-api-keys", "SELECT 1"), /read and COMMIT/);
      assert.equal(checkouts, 1);
      assert.ok(released[0] instanceof Error, "Uncertain transaction connections are destroyed");
    } finally { await pool.end(); }
  }
});

test("a dead socket read retries once on a fresh client; query timeout and SQL errors never retry", async (t) => {
  for (const kind of ["socket", "timeout", "statement"] as const) {
    const pool = createRuntimePool("postgres://localhost:9/unused", PARTNER_VERIFIER_POOL_SETTINGS);
    let checkouts = 0;
    let rollbacks = 0;
    const releases: (Error | undefined)[] = [];
    const sqlError = Object.assign(new DatabaseError("cancelled", 0, "error"), { code: "57014", severity: "ERROR" });
    t.mock.method(pool, "connect", async () => {
      const attempt = ++checkouts;
      return { async query(sql: string) {
        if (sql === "ROLLBACK") { rollbacks += 1; return { command: "ROLLBACK" }; }
        if (attempt > 1) return complete;
        throw kind === "statement" ? sqlError : new Error(kind === "timeout" ? "Query read timeout" : "Connection terminated unexpectedly");
      }, on() {}, removeListener() {}, release(error?: Error) { releases.push(error); } } as unknown as PoolClient;
    });
    try {
      if (kind === "socket") {
        assert.deepEqual((await batchedRead(pool, "partner-api-keys", "SELECT 1")).rows, [{ ok: 1 }]);
        assert.equal(checkouts, 2);
        assert.ok(releases[0] instanceof Error);
        assert.equal(releases[1], undefined);
      } else {
        await assert.rejects(batchedRead(pool, "partner-api-keys", "SELECT 1"));
        assert.equal(checkouts, 1);
        assert.equal(rollbacks, kind === "statement" ? 1 : 0);
        assert.equal(releases[0] instanceof Error, kind === "timeout");
      }
    } finally { await pool.end(); }
  }
});
