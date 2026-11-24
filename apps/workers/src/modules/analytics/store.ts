import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import type { Fact } from "./facts.ts";

// Callers serialize collection with the warehouse advisory lock (198401, 1).
// A changed source/hash/coverage scope requires an explicit rebuild, never silent reuse.
export async function initializeWarehouse(client: PoolClient, scope: string, firstCheckpoint: string): Promise<void> {
  requireCoordinate(firstCheckpoint);
  await client.query(
    "INSERT INTO blast_analytics.state(singleton,scope,first_checkpoint) VALUES(TRUE,$1,$2) ON CONFLICT DO NOTHING",
    [scope, firstCheckpoint],
  );
  const result = await client.query<{ matches: boolean }>(
    "SELECT scope=$1 AND first_checkpoint=$2::bigint AS matches FROM blast_analytics.state WHERE singleton", [scope, firstCheckpoint],
  );
  if (!result.rows[0]?.matches) {
    throw new Error("Analytics scope changed; rebuild required");
  }
}

type Batch = Readonly<{
  facts: readonly Fact[];
  checkpoint: string;
  digest: string;
  timestampMs: string;
  startTimestampMs?: string;
  complete?: boolean;
}>;
type State = {
  first_checkpoint: string;
  checkpoint: string | null;
  digest: string | null;
  timestamp_ms: string | null;
  pending_checkpoint: string | null;
  pending_digest: string | null;
  pending_timestamp_ms: string | null;
};

function requireCoordinate(value: string): void {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new Error("Analytics coordinates must be canonical PostgreSQL unsigned bigint strings");
  }
}

function requireCoordinates(batch: Batch): void {
  requireCoordinate(batch.checkpoint);
  requireCoordinate(batch.timestampMs);
  if (batch.startTimestampMs !== undefined) {
    requireCoordinate(batch.startTimestampMs);
  }
  for (const fact of batch.facts) {
    requireCoordinate(fact.checkpoint);
    requireCoordinate(fact.timestamp_ms);
  }
}

function requireProgress(state: State, batch: Batch): void {
  if (BigInt(batch.checkpoint) < BigInt(state.first_checkpoint)) {
    throw new Error("Analytics checkpoint precedes coverage");
  }
  if (state.pending_checkpoint !== null) {
    if (batch.checkpoint !== state.pending_checkpoint || batch.digest !== state.pending_digest || batch.timestampMs !== state.pending_timestamp_ms) {
      throw new Error("Analytics pending checkpoint must finish before advancing");
    }
    return;
  }
  if (state.checkpoint === null) {
    return;
  }
  if (BigInt(batch.checkpoint) < BigInt(state.checkpoint) || BigInt(batch.timestampMs) < BigInt(state.timestamp_ms!)) {
    throw new Error("Analytics checkpoint cannot move backwards");
  }
  if (batch.checkpoint === state.checkpoint && (batch.digest !== state.digest || batch.timestampMs !== state.timestamp_ms || batch.complete === false)) {
    throw new Error("Analytics completed checkpoint changed; rebuild required");
  }
}

function requireFactBounds(state: State, batch: Batch): void {
  const first = BigInt(state.first_checkpoint);
  const cut = BigInt(batch.checkpoint);
  const timestamp = BigInt(batch.timestampMs);
  if (batch.facts.some((fact) => BigInt(fact.checkpoint) < first || BigInt(fact.checkpoint) > cut || BigInt(fact.timestamp_ms) > timestamp)) {
    throw new Error("Analytics fact lies outside the batch coverage");
  }
}

export async function importBatch(
  client: PoolClient,
  batch: Batch,
  walletKey: string,
): Promise<void> {
  if (batch.facts.length > 5000) {
    throw new Error("Analytics batches are limited to 5000 facts");
  }
  if (walletKey.length < 32) {
    throw new Error("Analytics wallet key must have at least 32 characters");
  }
  if (batch.complete === false && batch.facts.length === 0) {
    throw new Error("Partial batch cannot be empty");
  }
  requireCoordinates(batch);
  const facts = batch.facts.map(({ actor, ...fact }) => ({
    ...fact,
    actor_hash:
      actor === null
        ? null
        : createHmac("sha256", walletKey).update(actor).digest("hex"),
  }));
  const encoded = JSON.stringify(facts);
  if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
    throw new Error("Analytics batches are limited to 16 MiB");
  }
  await client.query("BEGIN");
  try {
    const result = await client.query<State>(
      "SELECT first_checkpoint::text,checkpoint::text,digest,timestamp_ms::text,pending_checkpoint::text,pending_digest,pending_timestamp_ms::text FROM blast_analytics.state WHERE singleton FOR UPDATE",
    );
    const state = result.rows[0];
    if (!state) {
      throw new Error("Analytics warehouse must be initialized");
    }
    requireProgress(state, batch);
    requireFactBounds(state, batch);
    if (state.checkpoint === batch.checkpoint) {
      const missing = await client.query<{ missing: boolean }>(
        `SELECT EXISTS (SELECT FROM jsonb_array_elements($1::jsonb) fact
          WHERE NOT EXISTS (SELECT FROM blast_analytics.facts stored WHERE stored.fact_id=fact->>'fact_id')) AS missing`,
        [encoded],
      );
      if (missing.rows[0]?.missing) {
        throw new Error("Analytics completed checkpoint has new facts; rebuild required");
      }
    }
    await client.query(IMPORT_FACTS, [encoded]);
    if (batch.startTimestampMs !== undefined) {
      await client.query(
        "UPDATE blast_analytics.state SET first_timestamp_ms=coalesce(first_timestamp_ms,$1) WHERE singleton",
        [batch.startTimestampMs],
      );
    }
    if (batch.complete === false) {
      const last = batch.facts[batch.facts.length - 1]!;
      await client.query(
        "UPDATE blast_analytics.state SET pending_checkpoint=$1,pending_digest=$2,pending_fact_id=$3,pending_timestamp_ms=$4 WHERE singleton",
        [batch.checkpoint, batch.digest, last.fact_id, batch.timestampMs],
      );
    } else {
      await client.query(
        "UPDATE blast_analytics.state SET checkpoint=$1,digest=$2,timestamp_ms=$3,pending_checkpoint=NULL,pending_digest=NULL,pending_fact_id=NULL,pending_timestamp_ms=NULL WHERE singleton",
        [batch.checkpoint, batch.digest, batch.timestampMs],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Counts only rows inserted by this transaction, so retries cannot inflate totals.
const IMPORT_FACTS = `
WITH added AS (
  INSERT INTO blast_analytics.facts
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS f(
    fact_id text, checkpoint bigint, timestamp_ms bigint, digest text,
    actor_hash text, kind text, coin_type text, usd_value numeric, quote_type text, quote_amount numeric)
  ON CONFLICT DO NOTHING RETURNING *
), wallets AS (
  INSERT INTO blast_analytics.wallets SELECT DISTINCT actor_hash FROM added WHERE actor_hash IS NOT NULL
  ON CONFLICT DO NOTHING RETURNING *
), transactions AS (
  INSERT INTO blast_analytics.transactions SELECT DISTINCT digest FROM added WHERE digest IS NOT NULL
  ON CONFLICT DO NOTHING RETURNING *
), coins AS (
  INSERT INTO blast_analytics.coins SELECT DISTINCT coin_type FROM added WHERE kind = 'coin_launched'
  ON CONFLICT DO NOTHING RETURNING *
), trades AS (
  INSERT INTO blast_analytics.trade_receipts
  SELECT fact_id, timestamp_ms, usd_value FROM added WHERE kind = 'trade'
  ON CONFLICT DO NOTHING RETURNING *
), quote_totals AS (
  INSERT INTO blast_analytics.quote_totals SELECT quote_type, sum(quote_amount) FROM added
  WHERE kind = 'trade' AND quote_type IS NOT NULL GROUP BY quote_type
  ON CONFLICT (quote_type) DO UPDATE SET atoms = blast_analytics.quote_totals.atoms + EXCLUDED.atoms
), increments AS (
  SELECT kind, count(*) AS count, count(usd_value) AS priced, coalesce(sum(usd_value),0) AS usd_value
    FROM added WHERE kind <> 'trade' GROUP BY kind
  UNION ALL SELECT 'active_wallets', count(*), 0, 0 FROM wallets
  UNION ALL SELECT 'transactions', count(*), 0, 0 FROM transactions
  UNION ALL SELECT 'launched_coins', count(*), 0, 0 FROM coins
  UNION ALL SELECT 'trade_volume', count(*), count(usd_value), coalesce(sum(usd_value),0) FROM trades
)
INSERT INTO blast_analytics.totals SELECT * FROM increments
ON CONFLICT (kind) DO UPDATE SET
  count = blast_analytics.totals.count + EXCLUDED.count,
  priced = blast_analytics.totals.priced + EXCLUDED.priced,
  usd_value = blast_analytics.totals.usd_value + EXCLUDED.usd_value`;

export async function publishSnapshot(
  client: PoolClient,
  head: string,
): Promise<void> {
  await client.query(PUBLISH_SNAPSHOT, [head]);
}

// Lifetime totals are maintained on ingest; rolling scans touch at most 30 days in this DB.
const PUBLISH_SNAPSHOT = `
WITH state AS (SELECT * FROM blast_analytics.state WHERE checkpoint IS NOT NULL AND pending_checkpoint IS NULL),
windows AS (
  SELECT '24h' AS label, timestamp_ms + 1 - 86400000 AS start_ms, timestamp_ms + 1 AS end_ms FROM state
  UNION ALL SELECT '30d', timestamp_ms + 1 - 2592000000, timestamp_ms + 1 FROM state
), volumes AS (
  SELECT w.label, count(t.fact_id)::text AS receipts, count(t.usd_value)::text AS priced_receipts,
         coalesce(sum(t.usd_value),0)::text AS priced_usd
  FROM windows w LEFT JOIN blast_analytics.trade_receipts t
    ON t.timestamp_ms >= w.start_ms AND t.timestamp_ms < w.end_ms GROUP BY w.label
), active AS (
  SELECT w.label, count(DISTINCT f.actor_hash)::text AS wallets
  FROM windows w LEFT JOIN blast_analytics.facts f
    ON f.timestamp_ms >= w.start_ms AND f.timestamp_ms < w.end_ms GROUP BY w.label
), daily AS (
  SELECT (trade_receipts.timestamp_ms / 86400000 * 86400000)::text AS day_ms,
         count(*)::text AS receipts, count(usd_value)::text AS priced_receipts,
         coalesce(sum(usd_value),0)::text AS priced_usd
  FROM blast_analytics.trade_receipts, state
  WHERE trade_receipts.timestamp_ms >= (state.timestamp_ms / 86400000 - 29) * 86400000
    AND trade_receipts.timestamp_ms <= state.timestamp_ms
  GROUP BY trade_receipts.timestamp_ms / 86400000 ORDER BY trade_receipts.timestamp_ms / 86400000
)
INSERT INTO blast_analytics.snapshots
SELECT TRUE, clock_timestamp(), jsonb_build_object(
  'version', 2, 'volumeMethod', 'registered-pool-quote-receipts-v1',
  'volumeUnit', 'registered-pool-turnover-usd', 'pricingPolicy', 'historical-quote-oracle-60s-100bps-v1',
  'auditedTotalTradeVolumeUsd', (SELECT CASE WHEN count = priced THEN usd_value::text END FROM blast_analytics.totals WHERE kind = 'trade_volume'),
  'quoteTotals', (SELECT coalesce(jsonb_object_agg(quote_type,atoms::text),'{}'::jsonb) FROM blast_analytics.quote_totals),
  'asOfCheckpoint', s.checkpoint::text, 'asOfTimestampMs', s.timestamp_ms::text,
  'windowEndExclusiveMs', (s.timestamp_ms + 1)::text,
  'coverageStartCheckpoint', s.first_checkpoint::text, 'coverageStartTimestampMs', s.first_timestamp_ms::text,
  'historyScope', 'since-configured-checkpoint', 'catchingUp', s.checkpoint < $1::bigint,
  'transactionScope', 'selected-launch-presale-trade-facts',
  'users', jsonb_build_object('unit', 'active-wallets',
    'dau24h', (SELECT wallets FROM active WHERE label = '24h'),
    'mau30d', (SELECT wallets FROM active WHERE label = '30d'),
    'uniqueSinceCoverage', coalesce((SELECT count::text FROM blast_analytics.totals WHERE kind = 'active_wallets'),'0'),
    'productDau', NULL, 'productMau', NULL),
  'accountActivity', NULL,
  'totals', (SELECT coalesce(jsonb_object_agg(kind, jsonb_build_object(
    'count', count::text, 'pricedCount', priced::text, 'pricedUsd', usd_value::text)), '{}'::jsonb)
    FROM blast_analytics.totals),
  'volumeWindows', (SELECT jsonb_object_agg(label, to_jsonb(v) - 'label') FROM volumes v),
  'dailyTradeVolume', (SELECT coalesce(jsonb_agg(d), '[]'::jsonb) FROM daily d)
) FROM state s
ON CONFLICT (singleton) DO UPDATE SET generated_at = EXCLUDED.generated_at, payload = EXCLUDED.payload`;
