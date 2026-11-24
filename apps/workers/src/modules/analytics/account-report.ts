import type { PoolClient } from "pg";
import {
  accountActivityReport,
  aggregateSnapshot,
  aggregateSnapshotV3,
} from "./contract.ts";

/** Warehouse time owns the complete report, independently of chain progress. */
export async function publishAccountSnapshot(
  client: PoolClient,
  scope: string,
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await client.query(
      "SET LOCAL statement_timeout=2000; SET LOCAL lock_timeout=250",
    );
    const { rows } = await client.query<{ observed_at: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS observed_at",
    );
    const observedAt = rows[0]!.observed_at;
    const activity = await readAccountReport(client, scope, observedAt);
    const chain = await client.query<{ payload: unknown; generated_at: Date }>(
      "SELECT generated_at,payload FROM blast_analytics.snapshots WHERE singleton",
    );
    if (!chain.rows[0]) {
      throw new Error("Version 2 chain snapshot unavailable");
    }
    const payload = aggregateSnapshotV3.parse({
      ...aggregateSnapshot.parse(chain.rows[0].payload),
      version: 3,
      chainPublicationTimestampMs: chain.rows[0].generated_at
        .getTime()
        .toString(),
      accountObservationTimestampMs: observedAt.getTime().toString(),
      accountActivity: activity,
    });
    await client.query(
      `INSERT INTO blast_analytics.snapshots_v3 VALUES(TRUE,$1,$2)
       ON CONFLICT(singleton) DO UPDATE SET generated_at=excluded.generated_at,payload=excluded.payload`,
      [observedAt, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** The publisher supplies one trusted warehouse timestamp; SQL returns aggregates only. */
export async function readAccountReport(
  client: PoolClient,
  scope: string,
  observedAt: Date,
) {
  if (
    !/^[0-9a-f]{64}$/.test(scope) ||
    !Number.isSafeInteger(observedAt.getTime())
  ) {
    throw new Error("Invalid account reporting coordinates");
  }
  const result = await client.query<{
    matches: boolean | null;
    started_at: Date | null;
    payload: unknown;
  }>(ACCOUNT_REPORT, [scope, observedAt]);
  const row = result.rows[0];
  if (!row || (row.started_at !== null && row.matches !== true)) {
    throw new Error("Account reporting scope changed; reconciliation required");
  }
  if (row.started_at === null) {
    return null;
  }
  if (row.started_at > observedAt) {
    throw new Error("Account collection starts after observation");
  }
  return accountActivityReport.parse(row.payload);
}

// last_seen lower edges are exclusive and T inclusive. Future observations never enter windows.
// Daily rows with a future last_seen are conservatively omitted, even on an earlier UTC date.
const ACCOUNT_REPORT = `
WITH observation AS (SELECT $2::timestamptz AS t), collection AS (
  SELECT started_at,scope=$1 AS matches FROM blast_analytics.account_collection WHERE singleton
), days AS (
  SELECT generate_series(greatest(floor(extract(epoch FROM started_at)/86400)::bigint,
    floor(extract(epoch FROM t)/86400)::bigint-29),floor(extract(epoch FROM t)/86400)::bigint) AS day
  FROM collection,observation WHERE started_at IS NOT NULL AND started_at<=t
), daily AS (
  SELECT (d.day*86400000)::text AS day_ms,count(a.account_hash)::text AS accounts
  FROM days d CROSS JOIN observation o CROSS JOIN collection c
  LEFT JOIN blast_analytics.account_days ad ON ad.day=(timestamp 'epoch'+d.day*interval '1 day')::date
  LEFT JOIN blast_analytics.accounts a ON a.account_hash=ad.account_hash
    AND a.first_seen>=c.started_at AND a.first_seen<=o.t AND a.last_seen<=o.t
  GROUP BY d.day ORDER BY d.day
), counts AS (
  SELECT count(*) FILTER(WHERE a.last_seen>o.t-interval '24 hours' AND a.last_seen<=o.t)::text AS dau,
    count(*) FILTER(WHERE a.last_seen>o.t-interval '720 hours' AND a.last_seen<=o.t)::text AS mau,
    count(*)::text AS collected
  FROM blast_analytics.accounts a CROSS JOIN observation o CROSS JOIN collection c
  WHERE a.first_seen>=c.started_at AND a.first_seen<=o.t
)
SELECT c.matches,c.started_at,jsonb_build_object(
  'unit','authenticated-existing-accounts','collectionStartedAt',
    to_char(c.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'dau24h',counts.dau,'mau30d',counts.mau,'uniqueSinceCollection',counts.collected,
  'partial30d',c.started_at>o.t-interval '720 hours','samplingIntervalMs',900000,
  'daily',(SELECT coalesce(jsonb_agg(daily),'[]'::jsonb) FROM daily)
) AS payload FROM collection c CROSS JOIN observation o CROSS JOIN counts`;
