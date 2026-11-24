// Lease rows: one per (job, key) while a worker process works on it. The
// transaction pooler gives no session, so a lease is a row with a short
// expiry, never an advisory lock. A lease keeps two processes from working on
// the same record at once; it never decides an outcome (the chain does).

import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { workerDatabase } from "#workers/lib/database.ts";
import { workerLeases as lease } from "#workers/lib/database/schema.ts";

export type Leases = Readonly<{
  holder: string;
  /**
   * Takes the key when it is free or expired. Not re-entrant: a second pass of
   * the same process does not get a key its first pass holds.
   */
  acquire(job: string, key: string): Promise<boolean>;
  /** Extends this holder's unexpired lease; false when it was lost. */
  renew(job: string, key: string): Promise<boolean>;
  release(job: string, key: string): Promise<void>;
}>;

export function leases(pool: Pool, holder: string, ttlMs: number): Leases {
  const db = workerDatabase(pool, "worker-runtime");
  const expiresAt = sql`now() + ${ttlMs} * INTERVAL '1 millisecond'`;
  const heldByThisProcess = (job: string, key: string) => and(
    eq(lease.job, job), eq(lease.leaseKey, key), eq(lease.holder, holder),
  );
  return Object.freeze({
    holder,
    async acquire(job: string, key: string) {
      const rows = await db.insert(lease).values({
        job, leaseKey: key, holder, acquiredAt: sql`now()`, expiresAt,
      }).onConflictDoUpdate({
        target: [lease.job, lease.leaseKey],
        set: { holder, acquiredAt: sql`now()`, expiresAt },
        setWhere: lte(lease.expiresAt, sql`now()`),
      }).returning({ holder: lease.holder });
      return rows.length === 1;
    },
    async renew(job: string, key: string) {
      const rows = await db.update(lease).set({ expiresAt }).where(and(
        heldByThisProcess(job, key), gt(lease.expiresAt, sql`now()`),
      )).returning({ holder: lease.holder });
      return rows.length === 1;
    },
    async release(job: string, key: string) {
      await db.delete(lease).where(heldByThisProcess(job, key));
    },
  });
}
