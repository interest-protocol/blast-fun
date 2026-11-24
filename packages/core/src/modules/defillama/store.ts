import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  DefillamaError,
  HOUR_SECONDS,
  METHODOLOGY,
  parseProfile,
  type Contract,
  type Coverage,
  type Profile,
  type Snapshot,
} from "./contracts.ts";
import { summarizeDailyFees, type DailyFees } from "./daily-fees.ts";

export type Summary = Omit<Snapshot, "items" | "contracts" | "native_replay"> & {
  daily_fees?: DailyFees;
};
export type Publication = { id: string; revision: number; summary: Summary; published_at: Date };
export type Selector = { date: string } | { timestamp: number };
export type PublishedDay = { id: string; date: string; coverage: Coverage; published_at: Date };
export type Catalogue = { latest: Publication | null; days: PublishedDay[] };

function feedKey(profile: Profile): string {
  return createHash("sha256")
    .update(JSON.stringify({ methodology: METHODOLOGY, profile: parseProfile(profile) }))
    .digest("hex");
}

function hourKey(feed: string, start: number): string {
  return createHash("sha256").update(`${feed}:hour:${start}`).digest("hex");
}

export async function publishSnapshot(
  pool: Pool,
  snapshot: Snapshot,
): Promise<{ id: string; revision: number }> {
  const hourly = snapshot.end_timestamp - snapshot.start_timestamp === HOUR_SECONDS;
  const fees = summarizeDailyFees(snapshot);
  if (hourly && !fees) {
    throw new Error("Complete coverage is required for hourly fees");
  }
  // Hourly summaries share the append-only store. Daily audit rows and replay bases stay on the daily feed.
  const publication = hourly
    ? {
        ...snapshot,
        daily_fees: fees,
        items: [],
        contracts: [],
        native_replay: undefined,
      }
    : { ...snapshot, daily_fees: fees };
  // PostgreSQL JSONB can reorder fields in restored objects. The same evidence
  // hashes identically whether replayed from the floor or resumed.
  const json = JSON.stringify(publication, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
  const id = createHash("sha256").update(json).digest("hex");
  const { items, contracts, native_replay, ...summary } = publication;
  const dayFeed = feedKey(snapshot.profile);
  const feed = hourly ? hourKey(dayFeed, snapshot.start_timestamp) : dayFeed;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `defillama:${feed}:${snapshot.date}`,
    ]);
    const existing = await client.query<{ revision: number }>(
      "SELECT revision FROM defillama.snapshots WHERE id=$1",
      [id],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { id, revision: existing.rows[0].revision };
    }
    const inserted = await client.query<{ revision: number }>(
      `INSERT INTO defillama.snapshots(id,fingerprint,date,revision,summary,feed_key)
       SELECT $1,$2,$3,coalesce(max(revision),0)+1,$4::JSONB,$5 FROM defillama.snapshots WHERE feed_key=$5 AND date=$3 RETURNING revision`,
      [id, snapshot.profile.deployment_fingerprint, snapshot.date, JSON.stringify(summary), feed],
    );
    for (let offset = 0; offset < items.length; offset += 500) {
      await client.query(
        `INSERT INTO defillama.items(snapshot_id,ordinal,payload)
         SELECT $1, $2::INTEGER + ordinality::INTEGER - 1, value FROM jsonb_array_elements($3::JSONB) WITH ORDINALITY`,
        [id, offset, JSON.stringify(items.slice(offset, offset + 500))],
      );
    }
    for (let offset = 0; offset < contracts.length; offset += 500) {
      await client.query(
        `INSERT INTO defillama.contracts(snapshot_id,ordinal,created_ms,payload)
         SELECT $1, $2::INTEGER + ordinality::INTEGER - 1, (value->>'created_timestamp_ms')::BIGINT, value
         FROM jsonb_array_elements($3::JSONB) WITH ORDINALITY`,
        [id, offset, JSON.stringify(contracts.slice(offset, offset + 500))],
      );
    }
    if (native_replay) {
      await client.query("INSERT INTO defillama.native_replay(snapshot_id,payload) VALUES ($1,$2::JSONB)", [
        id, JSON.stringify(native_replay),
      ]);
    }
    await client.query("COMMIT");
    return { id, revision: inserted.rows[0]!.revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function publishedFeeHours(pool: Pool, profile: Profile, starts: readonly number[]) {
  const feed = feedKey(profile);
  const keys = starts.map((start) => hourKey(feed, start));
  const { rows } = await pool.query<Publication>(
    `SELECT DISTINCT ON (feed_key) id,revision,summary,published_at FROM defillama.snapshots
     WHERE feed_key=ANY($1::TEXT[]) ORDER BY feed_key,revision DESC`,
    [keys],
  );
  return new Map(rows.map((row) => [row.summary.start_timestamp, row]));
}

export type ReplayBase = {
  source: Snapshot["source"];
  state: NonNullable<Snapshot["native_replay"]>;
  contracts: Contract[];
};

export async function loadReplayBase(pool: Pool, profile: Profile, date: string): Promise<ReplayBase | undefined> {
  const latest = await pool.query<Omit<ReplayBase, "contracts"> & { id: string }>(
    `SELECT s.id, s.summary->'source' AS source, r.payload AS state
     FROM defillama.snapshots s JOIN defillama.native_replay r ON r.snapshot_id=s.id
     WHERE s.feed_key=$1 AND s.date<$2::DATE
     ORDER BY s.date DESC, s.revision DESC LIMIT 1`,
    [feedKey(profile), date],
  );
  const base = latest.rows[0];
  if (!base) return;
  const contracts = await pool.query<{ payload: Contract }>(
    "SELECT payload FROM defillama.contracts WHERE snapshot_id=$1 ORDER BY ordinal",
    [base.id],
  );
  return { source: base.source, state: base.state, contracts: contracts.rows.map((row) => row.payload) };
}

export function reportingReads(pool: Pool, profile: Profile) {
  const feed = feedKey(profile);
  return {
    feeHours: (starts: readonly number[]) => publishedFeeHours(pool, profile, starts),
    async publications(): Promise<Catalogue> {
      const result = await pool.query<PublishedDay>(
        `SELECT DISTINCT ON (s.date) id,to_char(s.date,'YYYY-MM-DD') AS date,summary->'coverage' AS coverage,published_at FROM defillama.snapshots s
         WHERE feed_key=$1 ORDER BY s.date DESC,revision DESC LIMIT 10001`,
        [feed],
      );
      if (result.rows.length > 10000) {
        throw new Error("DefiLlama metadata history limit exceeded");
      }
      const newest = result.rows[0];
      const detail = newest
        ? await pool.query<Publication>(
            "SELECT id,revision,summary,published_at FROM defillama.snapshots WHERE id=$1",
            [newest.id],
          )
        : null;
      return { latest: detail?.rows[0] ?? null, days: result.rows };
    },
    async publication(selector: Selector, snapshotId?: string): Promise<Publication> {
      const byDate = "date" in selector;
      const constraint = byDate
        ? "date=$2::DATE"
        : "(summary->>'end_timestamp')::BIGINT > $2 AND (summary->'source'->>'history_start_ms')::BIGINT <= $2::BIGINT * 1000";
      const result = await pool.query<Publication>(
        `SELECT id,revision,summary,published_at FROM defillama.snapshots
         WHERE feed_key=$1 AND ${constraint} AND ($3::TEXT IS NULL OR id=$3)
         ORDER BY date ASC, revision DESC LIMIT 1`,
        [feed, byDate ? selector.date : selector.timestamp, snapshotId ?? null],
      );
      if (!result.rows[0]) {
        throw new DefillamaError(snapshotId ? "snapshot_not_found" : "not_published", 404);
      }
      return result.rows[0];
    },
    async page(
      id: string,
      table: "items" | "contracts",
      after: number,
      timestamp?: number,
      afterCreated = -1,
    ): Promise<{ ordinal: number; payload: unknown; created_ms?: string }[]> {
      const result = await pool.query<{ ordinal: number; payload: unknown; created_ms?: string }>(
        table === "contracts"
          ? `SELECT ordinal,payload,created_ms FROM defillama.contracts WHERE snapshot_id=$1
             AND (created_ms,ordinal)>($4::BIGINT,$2) AND created_ms <= $3::BIGINT * 1000 ORDER BY created_ms,ordinal LIMIT 101`
          : "SELECT ordinal,payload FROM defillama.items WHERE snapshot_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 101",
        table === "contracts" ? [id, after, timestamp, afterCreated] : [id, after],
      );
      return result.rows;
    },
  };
}

export type ReportingReads = ReturnType<typeof reportingReads>;
