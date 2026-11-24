import type { Pool, PoolClient } from "pg";
import {
  analyticsPool,
  analyticsScope,
  type AnalyticsConfig,
} from "./config.ts";
import { readFactBatch, type Cursor } from "./source.ts";
import { importBatch, initializeWarehouse, publishSnapshot } from "./store.ts";
import { publishAccountSnapshot } from "./account-report.ts";

export async function refreshAnalytics(
  config: AnalyticsConfig,
  signal: AbortSignal,
): Promise<"busy" | "refreshed" | "aborted"> {
  // A fresh, owned session is discarded on every exit, including failed rollbacks/unlocks.
  const warehouse = analyticsPool(
    config.warehouseUrl,
    "blast-analytics-writer",
  );
  let source: Pool | undefined;
  try {
    if (signal.aborted) {
      return "aborted";
    }
    const destination = await warehouse.connect();
    let ownsLock = false;
    try {
      const lock = await destination.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(198401,1) AS acquired",
      );
      if (!lock.rows[0]?.acquired) {
        return "busy";
      }
      ownsLock = true;
      const isolated = await destination.query<{ isolated: boolean }>(
        "SELECT to_regnamespace('blast_infra') IS NULL AND to_regnamespace('chain_read_v1') IS NULL AS isolated",
      );
      if (!isolated.rows[0]?.isolated) {
        throw new Error("Analytics warehouse must be a separate database");
      }
      if (signal.aborted) {
        return "aborted";
      }

      source = analyticsPool(config.sourceUrl, "blast-analytics-source");
      const reader = await source.connect();
      try {
        return await collectBatches(reader, destination, config, signal);
      } finally {
        reader.release(true);
      }
    } finally {
      if (ownsLock) {
        await destination
          .query("SELECT pg_advisory_unlock(198401,1)")
          .catch(() => {});
      }
      // Discard the session as a fallback if rollback/unlock or connection health failed.
      destination.release(true);
    }
  } finally {
    await Promise.all([warehouse.end(), source?.end()]);
  }
}

async function collectBatches(
  reader: PoolClient,
  destination: PoolClient,
  config: AnalyticsConfig,
  signal: AbortSignal,
): Promise<"refreshed" | "aborted"> {
  const started = performance.now();
  let head: string | null = null;
  for (
    let batch = 0;
    batch < 20 && performance.now() - started < 30_000 && !signal.aborted;
    batch++
  ) {
    const previous = (
      await destination.query<Cursor>(
        `SELECT checkpoint::text,digest,timestamp_ms::text,pending_checkpoint::text,
              pending_digest,pending_timestamp_ms::text,pending_fact_id
       FROM blast_analytics.state WHERE singleton`,
      )
    ).rows[0];
    const result = await readFactBatch(
      reader,
      config,
      previous ?? EMPTY_CURSOR,
    );
    if (signal.aborted) {
      return "aborted";
    }
    await initializeWarehouse(
      destination,
      analyticsScope(config, result.exclusionVersion),
      config.firstCheckpoint.toString(),
    );
    if (signal.aborted) {
      return "aborted";
    }
    head = result.head;
    if (result.batch === null) {
      break;
    }
    await importBatch(destination, result.batch, config.walletKey);
  }
  if (signal.aborted) {
    return "aborted";
  }
  await publishAvailableSnapshots(destination, head, config.accountReporting);
  return "refreshed";
}

export async function publishAvailableSnapshots(
  destination: PoolClient,
  head: string | null,
  accountReporting?: Readonly<{ scope: string }>,
): Promise<void> {
  if (head !== null) {
    await publishSnapshot(destination, head);
  }
  if (accountReporting) {
    await publishAccountSnapshot(destination, accountReporting.scope);
  }
}

const EMPTY_CURSOR: Cursor = {
  checkpoint: null,
  digest: null,
  timestamp_ms: null,
  pending_checkpoint: null,
  pending_digest: null,
  pending_timestamp_ms: null,
  pending_fact_id: null,
};
