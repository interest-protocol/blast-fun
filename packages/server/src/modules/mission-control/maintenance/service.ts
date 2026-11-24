import { z } from "zod";
import type { Pool } from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  CLEANUP_BATCH_SIZE,
  CLEANUP_BUDGET_MS,
  type CleanupOptions,
  type CleanupReport,
  type CleanupTable,
  type CleanupTableResult,
} from "@blast/core/modules/mission-control/maintenance/contracts.ts";
import {
  CLEANUP_TARGETS,
  deleteExpiredBatch,
  type CleanupTarget,
} from "./repository.ts";

interface Progress {
  batches: number;
  deleted: number;
  done: boolean;
  durationMs: number;
  error?: string;
  readonly target: CleanupTarget;
}

function checkedOptions(options: CleanupOptions) {
  const batchSize = options.batchSize ?? CLEANUP_BATCH_SIZE;
  const budgetMs = options.budgetMs ?? CLEANUP_BUDGET_MS;
  if (!z.number().int().min(1).max(CLEANUP_BATCH_SIZE).safeParse(batchSize).success) {
    throw new TypeError(`Cleanup batch size must be from 1 to ${CLEANUP_BATCH_SIZE}.`);
  }
  if (!z.number().int().min(0).max(5 * 60_000).safeParse(budgetMs).success) {
    throw new TypeError("Cleanup budget must be from 0 to 300000 ms.");
  }
  return { batchSize, budgetMs, clock: options.clock ?? (() => new Date()) };
}

async function cleanupBatch(
  pool: Pool,
  entry: Progress,
  now: Date,
  batchSize: number,
): Promise<void> {
  const batchStarted = performance.now();
  try {
    const deleted = await withTransaction(
      pool,
      (transaction) =>
        deleteExpiredBatch(transaction, entry.target, now, batchSize),
      { retry: true },
    );
    entry.batches += 1;
    entry.deleted += deleted;
    entry.done = deleted < batchSize;
  } catch (error) {
    entry.error = errorLabel(error);
    entry.done = true;
  } finally {
    entry.durationMs += performance.now() - batchStarted;
  }
}

/**
 * Deletes expired rows in bounded batches, one short transaction per batch.
 * Tables take turns one batch at a time, so a backlog in one table cannot
 * starve the others; a table is finished when a batch comes back short. The
 * run stops at the time budget and the next run continues. A failing table is
 * reported and skipped; the others still run.
 */
export async function runCleanup(
  pool: Pool,
  options: CleanupOptions = {},
): Promise<CleanupReport> {
  const { batchSize, budgetMs, clock } = checkedOptions(options);
  const now = clock();
  const started = performance.now();
  const withinBudget = () => performance.now() - started < budgetMs;
  const progress: Progress[] = CLEANUP_TARGETS.map((target) => ({
    batches: 0,
    deleted: 0,
    done: false,
    durationMs: 0,
    target,
  }));

  let next = 0;
  while (withinBudget() && progress.some((entry) => !entry.done)) {
    const entry = progress[next]!;
    next = (next + 1) % progress.length;
    if (!entry.done) await cleanupBatch(pool, entry, now, batchSize);
  }

  const tables = {} as Record<CleanupTable, CleanupTableResult>;
  for (const entry of progress) {
    const complete = entry.done && !entry.error;
    const durationMs = Math.round(entry.durationMs);
    recordMetric("maintenance.cleanup", {
      batches: entry.batches,
      complete,
      deleted: entry.deleted,
      durationMs,
      error: entry.error,
      outcome: entry.error ? "error" : "ok",
      table: entry.target.table,
    });
    tables[entry.target.table] = {
      batches: entry.batches,
      complete,
      deleted: entry.deleted,
      durationMs,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }
  const results = Object.values(tables);
  return {
    complete: results.every((result) => result.complete),
    durationMs: Math.round(performance.now() - started),
    ok: results.every((result) => !result.error),
    tables,
  };
}
