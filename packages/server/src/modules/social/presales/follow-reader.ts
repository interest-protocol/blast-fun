import type { Pool } from "pg";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { withTransaction, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";

const ACQUIRE_FOLLOW_SLOT = `
  SELECT slot FROM generate_series(0, $1::int - 1) AS slots(slot)
  WHERE pg_try_advisory_xact_lock(hashtext('blast.presale_follow_read'), slot)
  LIMIT 1`;

export type PresaleFollowLimits = Readonly<{ fleetSlots: number; processSlots: number }>;
export const DEFAULT_PRESALE_FOLLOW_LIMITS: PresaleFollowLimits = { fleetSlots: 4, processSlots: 2 };

export function createPresaleFollowReader(
  pool: Pool,
  { fleetSlots, processSlots }: PresaleFollowLimits = DEFAULT_PRESALE_FOLLOW_LIMITS,
): ReadableDatabase {
  const poolSize = pool.options.max ?? 10;
  const slots = createSemaphore(Math.min(processSlots, Math.max(1, Math.floor(poolSize / 4))));

  function refuse(reason: "pool_size" | "process" | "replica"): never {
    recordMetric("social.presales.follow", { outcome: "busy", reason });
    throw new SocialRouteError("service_unavailable");
  }

  return {
    async read(text, values, rowMode) {
      if (poolSize <= 1) refuse("pool_size");
      if (slots.active >= slots.limit) refuse("process");
      const release = await slots.acquire(0);
      try {
        // The replica owns the permit until the transaction ends, even after an API
        // disconnect. All processes and deploy generations share the same slot IDs.
        return await withTransaction(pool, async (transaction) => {
          const slot = await transaction.read(ACQUIRE_FOLLOW_SLOT, [fleetSlots]);
          if (slot.rows.length === 0) refuse("replica");
          return transaction.read(text, values, rowMode);
        }, {
          label: "social.presales.follow",
          signal: AbortSignal.timeout(750),
          timeouts: { statementTimeoutMs: 250, idleInTransactionMs: 1_000 },
        });
      } finally {
        release();
      }
    },
  };
}
