import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { AsOf } from "@blast/core/modules/social/contracts/items.ts";

type WatermarkRow = {
  market_checkpoint: string | null;
  market_timestamp_ms: string | null;
  presale_checkpoint: string | null;
  presale_timestamp_ms: string | null;
  observed_ms: string | null;
};

const WATERMARK_SQL = `SELECT market_checkpoint, market_timestamp_ms, presale_checkpoint, presale_timestamp_ms, observed_ms
FROM chain_read_v1.watermark`;

/**
 * The `as_of` of a social read from `chain_read_v1.watermark`: the slowest
 * pipeline's (the older committed timestamp; on a tie the lower checkpoint)
 * checkpoint and timestamp, and its age on the database's clock
 * (`observed_ms - timestamp_ms`, never negative). Null when the watermark
 * has no row or a pipeline has committed nothing readable yet: the data's
 * freshness is then unknown, and the route decides (for example 503).
 * Read it on the same database as the items.
 */
export async function readAsOf(db: ReadableDatabase): Promise<AsOf | null> {
  const row = (await db.read<WatermarkRow>(WATERMARK_SQL)).rows[0];
  if (!row || row.observed_ms === null) return null;
  const pipelines = [
    [row.market_checkpoint, row.market_timestamp_ms],
    [row.presale_checkpoint, row.presale_timestamp_ms],
  ] as const;
  if (pipelines.some(([checkpoint, timestamp]) => checkpoint === null || timestamp === null)) return null;
  const [checkpoint, timestampMs] = pipelines
    .map(([checkpoint, timestamp]) => [Number(checkpoint), Number(timestamp)] as const)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  return { checkpoint, timestamp_ms: timestampMs, lag_ms: Math.max(Number(row.observed_ms) - timestampMs, 0) };
}
