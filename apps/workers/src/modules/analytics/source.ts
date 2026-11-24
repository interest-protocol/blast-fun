import type { PoolClient } from "pg";
import { ANALYTICS_EXPORT_VERSION, type AnalyticsConfig } from "./config.ts";
import type { Fact } from "./facts.ts";

export type Cursor = Readonly<{
  checkpoint: string | null;
  digest: string | null;
  timestamp_ms: string | null;
  pending_checkpoint: string | null;
  pending_digest: string | null;
  pending_timestamp_ms: string | null;
  pending_fact_id: string | null;
}>;

// Identity, policy, anchors, coverage and facts must come from one replica snapshot.
export async function readFactBatch(client: PoolClient, config: AnalyticsConfig, cursor: Cursor) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const recovery = await client.query<{ replica: boolean }>(
      "SELECT pg_is_in_recovery() AS replica",
    );
    if (recovery.rows[0]?.replica !== true) {
      throw new Error("Analytics extraction requires a physical read replica");
    }

    const head = await requireCoverage(client, config);
    const policy = await requirePolicy(client);
    const from =
      cursor.checkpoint === null ? config.firstCheckpoint : BigInt(cursor.checkpoint) + 1n;
    if (
      policy.archived_through_checkpoint !== null &&
      from <= BigInt(policy.archived_through_checkpoint)
    ) {
      throw new Error("Analytics history is archived; restore archive before advancing");
    }
    await requireAnchors(client, cursor, from, head);
    const cut = await header(client, head);
    await requireCut(client, config, head, cut.digest);
    const batch =
      from > head
        ? null
        : await readBoundedFacts(client, config, from, head, cursor.pending_fact_id);

    await client.query("COMMIT");
    return {
      batch,
      exclusionVersion: policy.exclusion_version,
      head: head.toString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function requireCoverage(client: PoolClient, config: AnalyticsConfig): Promise<bigint> {
  const result = await client.query<{
    pipeline: string;
    network: string;
    deployment_fingerprint: string | null;
    checkpoint: string | null;
    first_checkpoint: string;
    fault_checkpoint: string | null;
  }>(
    `SELECT pipeline,network,deployment_fingerprint,checkpoint::text,first_checkpoint::text,fault_checkpoint::text
      FROM chain_read_v1.projection_coverage WHERE pipeline = ANY($1)`,
    [["intake", "market", "presale"]],
  );
  if (
    result.rows.length !== 3 ||
    new Set(result.rows.map((row) => row.pipeline)).size !== 3 ||
    result.rows.some(
      (row) =>
        row.network !== config.network ||
        row.deployment_fingerprint !== config.fingerprint ||
        row.checkpoint === null ||
        row.fault_checkpoint !== null ||
        BigInt(row.first_checkpoint) > config.firstCheckpoint ||
        BigInt(row.checkpoint) < BigInt(row.first_checkpoint),
    )
  ) {
    throw new Error("Analytics projection coverage incomplete or deployment mismatch");
  }
  return result.rows.reduce((minimum, row) => {
    const checkpoint = BigInt(row.checkpoint!);
    return checkpoint < minimum ? checkpoint : minimum;
  }, 9223372036854775807n);
}

async function requirePolicy(client: PoolClient) {
  const result = await client.query<{
    exclusion_version: string;
    archived_through_checkpoint: string | null;
    pool_registration_fault: boolean;
    export_version: string;
  }>(`SELECT exclusion_version,archived_through_checkpoint::text,pool_registration_fault,export_version
      FROM chain_read_v1.analytics_policy`);
  const policy = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !policy ||
    policy.export_version !== ANALYTICS_EXPORT_VERSION ||
    !policy.exclusion_version
  ) {
    throw new Error("Analytics source policy unavailable or unsupported");
  }
  if (policy.pool_registration_fault) {
    throw new Error("Analytics pool registration coverage incomplete");
  }
  return policy;
}

async function requireAnchors(client: PoolClient, cursor: Cursor, from: bigint, head: bigint) {
  if (cursor.checkpoint !== null) {
    const completed = await header(client, BigInt(cursor.checkpoint));
    if (
      completed.digest !== cursor.digest ||
      completed.timestamp_ms !== cursor.timestamp_ms ||
      BigInt(cursor.checkpoint) > head
    ) {
      throw new Error("Analytics source history changed; rebuild required");
    }
  }
  if (cursor.pending_checkpoint !== null) {
    const pending = await header(client, BigInt(cursor.pending_checkpoint));
    if (
      cursor.pending_checkpoint !== from.toString() ||
      from > head ||
      pending.digest !== cursor.pending_digest ||
      pending.timestamp_ms !== cursor.pending_timestamp_ms ||
      !cursor.pending_fact_id
    ) {
      throw new Error("Analytics pending history changed; rebuild required");
    }
    const anchor = await client.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT FROM chain_read_v1.analytics_facts WHERE checkpoint=$1 AND fact_id=$2) AS present",
      [cursor.pending_checkpoint, cursor.pending_fact_id],
    );
    if (!anchor.rows[0]?.present) {
      throw new Error("Analytics pending fact changed; rebuild required");
    }
  }
}

async function header(client: PoolClient, checkpoint: bigint) {
  const result = await client.query<{ digest: string; timestamp_ms: string }>(
    "SELECT digest,timestamp_ms::text FROM chain_read_v1.checkpoint_headers WHERE checkpoint=$1",
    [checkpoint.toString()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Analytics checkpoint header unavailable");
  }
  return row;
}

async function requireCut(
  client: PoolClient,
  config: AnalyticsConfig,
  checkpoint: bigint,
  digest: string,
) {
  await client.query("SELECT chain_read_v1.require_cut($1,$2,$3,$4,$5)", [
    config.network,
    config.fingerprint,
    checkpoint.toString(),
    digest,
    ["market", "presale"],
  ]);
}

async function readBoundedFacts(
  client: PoolClient,
  config: AnalyticsConfig,
  from: bigint,
  head: bigint,
  after: string | null,
) {
  let to = after !== null ? from : from + 9999n < head ? from + 9999n : head;
  const start = await header(client, from);
  while (true) {
    const end = await header(client, to);
    await requireCut(client, config, to, end.digest);
    const result = await client.query<Fact & { header_timestamp_ms: string | null }>(
      `SELECT f.fact_id,f.checkpoint::text,f.timestamp_ms::text,f.digest,f.actor,f.kind,f.coin_type,
              f.usd_value::text,f.quote_type,f.quote_amount::text,h.timestamp_ms::text AS header_timestamp_ms
       FROM chain_read_v1.analytics_facts f LEFT JOIN chain_read_v1.checkpoint_headers h USING(checkpoint)
       WHERE f.checkpoint BETWEEN $1 AND $2 AND ($3::text IS NULL OR f.fact_id COLLATE "C" > $3 COLLATE "C")
       ORDER BY f.checkpoint,f.fact_id COLLATE "C" LIMIT 5001`,
      [from.toString(), to.toString(), after],
    );
    if (BigInt(start.timestamp_ms) > BigInt(end.timestamp_ms)) {
      throw new Error("Analytics fact timestamp does not match checkpoint coverage");
    }
    const facts = result.rows.map(({ header_timestamp_ms, ...fact }) => {
      if (
        fact.timestamp_ms !== header_timestamp_ms ||
        BigInt(fact.timestamp_ms) < BigInt(start.timestamp_ms) ||
        BigInt(fact.timestamp_ms) > BigInt(end.timestamp_ms)
      ) {
        throw new Error("Analytics fact timestamp does not match checkpoint coverage");
      }
      return fact;
    });
    if (facts.length <= 5000 || to === from) {
      return {
        facts: facts.slice(0, 5000),
        checkpoint: to.toString(),
        digest: end.digest,
        timestampMs: end.timestamp_ms,
        startTimestampMs: start.timestamp_ms,
        complete: facts.length <= 5000,
      };
    }
    to = from + (to - from) / 2n;
  }
}
