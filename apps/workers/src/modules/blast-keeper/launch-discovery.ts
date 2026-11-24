// Every Blast curve launch, once: the keepers' discovery. blast-infra's
// committed `chain_read_v1.pools` lists each launch's curve pool from its
// creation (`pool_id` is the launch object ID). A job pages them in
// `(created_checkpoint, pool_key)` order, at or below the committed watermark
// checkpoint, behind its durable cursor (`mission_control_worker_jobs.cursor`),
// and records each page and the cursor in one transaction, so a restart
// neither skips nor repeats a launch, and a launch settled or migrated before
// the job first saw it is still visited.

import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { transactionDatabase } from "#workers/lib/database.ts";
import { workerJobs } from "#workers/lib/database/schema.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { withTransaction, type TransactionContext } from "@blast/core/modules/database/transaction.ts";

const CURVES = `SELECT pool_key, pool_id, coin_type, quote_type, created_checkpoint::text AS created_checkpoint
  FROM chain_read_v1.pools
  WHERE venue = 'blast_curve'
    AND created_checkpoint <= $1::bigint
    AND (created_checkpoint, pool_key) > ($2::bigint, $3::text)
    AND pool_id ~ '^0x[0-9a-f]{64}$'
  ORDER BY created_checkpoint, pool_key
  LIMIT $4`;
assertChainReadThroughViews(CURVES);

export type CurveLaunch = Readonly<{ launchId: string; memeType: string; quoteType: string; createdCheckpoint: bigint }>;

type Cursor = Readonly<{ checkpoint: string; poolKey: string }>;

/**
 * Records the next page of curve launches after `job`'s cursor, up to
 * `checkpoint`, through `record` (which must ignore launches already
 * recorded), and advances the cursor past them, in one transaction. Returns
 * how many launches the page held.
 */
export async function discoverCurveLaunches(
  pool: Pool,
  {
    job,
    network,
    checkpoint,
    limit,
    record,
  }: Readonly<{
    job: string;
    network: string;
    checkpoint: string;
    limit: number;
    record(transaction: TransactionContext, launches: readonly CurveLaunch[]): Promise<void>;
  }>,
): Promise<number> {
  return withTransaction(pool, async (transaction) => {
    const jobs = transactionDatabase(transaction.forModule("worker-runtime"));
    const state = await jobs.select({ cursor: sql<Cursor | null>`${workerJobs.cursor}` }).from(workerJobs)
      .where(and(eq(workerJobs.job, job), eq(workerJobs.network, network)));
    const cursor = state[0]?.cursor ?? { checkpoint: "-1", poolKey: "" };
    const { rows } = await transaction.read<{
      pool_key: string;
      pool_id: string;
      coin_type: string;
      quote_type: string;
      created_checkpoint: string;
    }>(CURVES, [checkpoint, cursor.checkpoint, cursor.poolKey, limit]);
    const last = rows.at(-1);
    if (!last) return 0;
    await record(transaction, rows.map((row) => ({
      launchId: row.pool_id,
      memeType: row.coin_type,
      quoteType: row.quote_type,
      createdCheckpoint: BigInt(row.created_checkpoint),
    })));
    const next: Cursor = { checkpoint: last.created_checkpoint, poolKey: last.pool_key };
    await jobs.insert(workerJobs).values({ job, network, cursor: next, updatedAt: sql`now()` })
      .onConflictDoUpdate({ target: [workerJobs.job, workerJobs.network], set: { cursor: next, updatedAt: sql`now()` } });
    return rows.length;
  }, { label: `${job}.discover` });
}
