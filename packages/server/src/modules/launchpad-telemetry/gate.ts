import type { Pool } from "pg";

import { createSemaphore, type Semaphore } from "@blast/server/lib/concurrency.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { TransactionTimeouts } from "@blast/core/modules/database/pool.ts";

/**
 * Telemetry shares the product's pool, so it must never hold connections or
 * server backends the product needs. Per process and pool, at most a quarter
 * of the pool (at least one connection) does telemetry work at once. A call
 * waits at most `LAUNCHPAD_GATE_WAIT_MS` for that share and never queues for
 * a connection: when the share stays busy, the pool has waiters, or every
 * connection is lent out, the work is refused (`dropped` upstream, reason
 * `LAUNCHPAD_TELEMETRY_BUSY`).
 *
 * Every statement inside runs in its own transaction with the SET LOCAL
 * budgets `LAUNCHPAD_STORAGE_TIMEOUTS`, so it ends on the server within them
 * (and rolls back, never committing later), and the share is released only
 * once the server has answered. The share therefore bounds telemetry's
 * backends too, not just its pool slots.
 */
export class LaunchpadTelemetryBusy extends Error {
  readonly code = "LAUNCHPAD_TELEMETRY_BUSY";

  constructor() {
    super("Launchpad telemetry stepped aside for the product's pool.");
    this.name = "LaunchpadTelemetryBusy";
  }
}

/** Server-side budgets for each telemetry statement, below the emitter's 1.5 s. */
export const LAUNCHPAD_STORAGE_TIMEOUTS: Readonly<TransactionTimeouts> = Object.freeze({
  statementTimeoutMs: 1_000,
  lockTimeoutMs: 500,
  idleInTransactionMs: 1_000,
});

/** How long a call may wait for telemetry's share of the pool (bursts of healthy load). */
export const LAUNCHPAD_GATE_WAIT_MS = 25;

const gates = processSingleton(
  "launchpad-telemetry.gates",
  () => new WeakMap<Pool, Semaphore>(),
);

function poolMax(pool: Pool): number {
  const max = pool.options?.max;
  return Number.isSafeInteger(max) && (max as number) > 0 ? (max as number) : 10;
}

/** How many connections (and server backends) telemetry may use at once on `pool`. */
export function telemetryShare(pool: Pool): number {
  return Math.max(1, Math.floor(poolMax(pool) / 4));
}

function gateFor(pool: Pool): Semaphore {
  let gate = gates.get(pool);
  if (!gate) {
    gate = createSemaphore(telemetryShare(pool));
    gates.set(pool, gate);
  }
  return gate;
}

function wouldWait(pool: Pool): boolean {
  return pool.waitingCount > 0 || (pool.totalCount >= poolMax(pool) && pool.idleCount === 0);
}

export async function withTelemetrySlot<Result>(
  pool: Pool,
  work: () => Promise<Result>,
): Promise<Result> {
  if (wouldWait(pool)) throw new LaunchpadTelemetryBusy();
  let release: () => void;
  try {
    release = await gateFor(pool).acquire(LAUNCHPAD_GATE_WAIT_MS);
  } catch {
    throw new LaunchpadTelemetryBusy();
  }
  try {
    // The pool may have filled while this call waited for the share.
    if (wouldWait(pool)) throw new LaunchpadTelemetryBusy();
    return await work();
  } finally {
    release();
  }
}
