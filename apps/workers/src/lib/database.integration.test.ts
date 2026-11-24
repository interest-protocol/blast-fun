import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { transactionDatabase, workerDatabase } from "./database.ts";
import { workerLeases } from "./database/schema.ts";

const connectionString = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("Drizzle preserves guarded queries, result mapping and rollback", { skip: !connectionString }, async (t) => {
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await migrateDatabase(pool);
  const db = workerDatabase(pool, "worker-runtime");
  await db.delete(workerLeases);
  const acquiredAt = new Date();
  const expiresAt = new Date(acquiredAt.getTime() + 60_000);
  const first = randomUUID();
  const second = randomUUID();
  await db.insert(workerLeases).values([
    { job: "drizzle-test", leaseKey: "first", holder: first, acquiredAt, expiresAt },
    { job: "drizzle-test", leaseKey: "second", holder: second, acquiredAt, expiresAt },
  ]);
  const other = alias(workerLeases, "other");
  const rows = await db.select({ first: workerLeases.holder, second: other.holder, expiresAt: workerLeases.expiresAt })
    .from(workerLeases).innerJoin(other, eq(workerLeases.job, other.job))
    .where(and(eq(workerLeases.leaseKey, "first"), eq(other.leaseKey, "second")));
  assert.deepEqual(rows, [{ first, second, expiresAt }]);
  assert.deepEqual(await db.select().from(workerLeases).where(eq(workerLeases.job, "x' OR TRUE --")), []);
  await assert.rejects(workerDatabase(pool, "social").delete(workerLeases), (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof Error);
    assert.match(error.cause.message, /cannot write table/);
    return true;
  });
  await assert.rejects(db.select().from(workerLeases).for("update"), (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof Error);
    assert.match(error.cause.message, /cannot take locks/);
    return true;
  });
  await assert.rejects(withTransaction(pool, async (transaction) => {
    const tx = transactionDatabase(transaction.forModule("worker-runtime"));
    const locked = await tx.select().from(workerLeases).for("update");
    assert.equal(locked.length, 2);
    await tx.delete(workerLeases);
    throw new Error("rollback-test");
  }), /rollback-test/);
  assert.equal((await db.select().from(workerLeases)).length, 2);
});
