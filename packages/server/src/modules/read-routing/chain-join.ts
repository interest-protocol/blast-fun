import { primaryPool } from "@blast/core/modules/database/pool.ts";
import type { Pool } from "pg";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { autocommitRead, autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { isDatabaseUnavailableError } from "@blast/core/modules/database/availability.ts";
import { isNeonUrl } from "@blast/core/modules/database/topology.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import {
  deploymentMismatch,
  expectedDeployment,
  parseWatermarkRow,
  type ExpectedDeployment,
} from "@blast/core/modules/launchpad-contract/provenance.ts";
import { WORKLOAD_ROUTES, type Provenance, type ReplicaResource, type RoutedRead } from "@blast/core/modules/read-routing/resources.ts";

/**
 * Where a database stands on the chain, read through blast-infra's
 * `chain_read_v1.watermark`: the indexed network and SDK deployment
 * fingerprint, the checkpoint blast-infra last committed there, its
 * timestamp, when the database answered, and how long ago (chain time) that
 * checkpoint was produced. A replica whose WAL receiver or replay has stopped
 * keeps its old checkpoint, so its age grows. The age also includes
 * blast-infra's own delay, so a lagging or halted indexer ages the primary as
 * much as the replica; see attributeLag. The checkpoint fields are null
 * before the first checkpoint, and every field but `inRecovery` is null
 * before blast-infra has started on the database.
 */
export type ChainPosition = Readonly<{
  inRecovery: boolean;
  network: string | null;
  deployment: string | null;
  checkpoint: number | null;
  timestampMs: number | null;
  observedAt: number | null;
  lagMs: number | null;
}>;

export type ChainJoinDependencies = Readonly<{
  replica: ReadableDatabase;
  primary: ReadableDatabase;
  position: (source: "replica" | "primary") => Promise<ChainPosition>;
  now: () => number;
  /** A managed replica must be in recovery; a local stand-in need not. */
  requireRecovery: boolean;
  /** The deployment this app serves; a database indexing another serves no join. Null checks nothing. */
  expected?: ExpectedDeployment | null;
}>;

/**
 * One statement, so it works through Neon's transaction-mode pooler, on the
 * primary and the replica alike. The age is measured on that database's
 * clock against the checkpoint's own timestamp.
 */
const CHAIN_POSITION_SQL = `SELECT pg_is_in_recovery() AS in_recovery,
  w.network, w.deployment_fingerprint, w.checkpoint, w.timestamp_ms, w.observed_ms, w.lag_ms
FROM (SELECT 1) AS probe
LEFT JOIN chain_read_v1.watermark AS w ON TRUE`;

export async function measureChainPosition(
  pool: Pool,
  /** Which database `pool` is; it only labels a contract violation. */
  source: "replica" | "primary" = "replica",
): Promise<ChainPosition> {
  const result = await autocommitRead<{ in_recovery: boolean; network: string | null } & Record<string, unknown>>(
    pool,
    "chain-read",
    CHAIN_POSITION_SQL,
  );
  const row = result.rows[0];
  const inRecovery = row?.in_recovery === true;
  if (!row || row.network === null) {
    return {
      inRecovery, network: null, deployment: null, checkpoint: null, timestampMs: null, observedAt: null, lagMs: null,
    };
  }
  const position = parseWatermarkRow(row, source);
  return {
    inRecovery,
    network: position.network,
    deployment: position.deployment,
    checkpoint: position.checkpoint,
    timestampMs: position.timestampMs,
    observedAt: position.observedAt,
    lagMs: position.lagMs,
  };
}

const POSITION_CACHE_MS = 1_000;
const positionCache = processSingleton(
  "read-routing.chain-position",
  () => new WeakMap<Pool, { at: number; reading: Promise<ChainPosition> }>(),
);

/** One position probe per pool per second, shared by concurrent requests. A failed probe is not kept. */
export function cachedChainPosition(pool: Pool, now = Date.now()): Promise<ChainPosition> {
  const cached = positionCache.get(pool);
  if (cached && now - cached.at < POSITION_CACHE_MS) return cached.reading;
  const reading = measureChainPosition(pool);
  positionCache.set(pool, { at: now, reading });
  reading.catch(() => {
    if (positionCache.get(pool)?.reading === reading) positionCache.delete(pool);
  });
  return reading;
}

function defaultDependencies(resource: ReplicaResource): ChainJoinDependencies {
  const replica = databaseFor(resource);
  return {
    replica: autocommitReader(replica, "chain-read", { label: resource }),
    primary: {
      read: (text, values) => autocommitReader(primaryPool(), "chain-read", { label: resource }).read(text, values),
    },
    position: (source) => cachedChainPosition(source === "replica" ? replica : primaryPool()),
    now: Date.now,
    requireRecovery: isNeonUrl(String(replica.options.connectionString ?? "")),
    expected: expectedDeployment(),
  };
}

/** `database`, refusing any statement that names chain data other than the chain_read_v1 views. */
function throughChainViews(database: ReadableDatabase): ReadableDatabase {
  return {
    read: (text, values) => {
      assertChainReadThroughViews(text);
      return database.read(text, values);
    },
  };
}

function provenance(
  source: "replica" | "primary",
  position: ChainPosition | null,
  observedAt: number,
  reason?: string,
): Provenance {
  return {
    source,
    network: position?.network ?? null,
    deployment: position?.deployment ?? null,
    checkpoint: position?.checkpoint ?? null,
    timestampMs: position?.timestampMs ?? null,
    observedAt: position?.observedAt ?? observedAt,
    lagMs: position?.lagMs ?? null,
    ...(reason ? { reason } : {}),
  };
}

type LagReason = "replica-lag" | "indexer-lag" | "primary-unavailable" | "no-checkpoint";

/**
 * Why a replica that answers is outside its policy, and whether the primary
 * serves the join instead. The primary serves it only when its checkpoint is
 * strictly ahead of the replica's **and** the primary itself is within the
 * resource's freshness policy (`replica-lag`). A primary that is equal, or
 * ahead but also outside the policy (blast-infra lagging, catching up or
 * halted), gives `indexer-lag` and the replica keeps the join.
 */
function attributeLag(
  replica: ChainPosition,
  primary: ChainPosition | null,
  maxLagMs: number,
): { reason: LagReason; primaryHelps: boolean } {
  if (primary === null) return { reason: "primary-unavailable", primaryHelps: false };
  if (primary.checkpoint === null) {
    return { reason: replica.checkpoint === null ? "no-checkpoint" : "indexer-lag", primaryHelps: false };
  }
  const ahead = replica.checkpoint === null || primary.checkpoint > replica.checkpoint;
  const primaryFresh = primary.lagMs !== null && primary.lagMs <= maxLagMs;
  return ahead && primaryFresh
    ? { reason: "replica-lag", primaryHelps: true }
    : { reason: "indexer-lag", primaryHelps: false };
}

/**
 * Runs a chain join (search, thesis) on the replica, or degrades it as the
 * resource's policy says. Freshness is the age of the source's committed
 * checkpoint, and every answer names that checkpoint and its chain.
 *
 * - The replica within `maxLagMs`: fresh from the replica.
 * - Outside it, the primary's checkpoint strictly ahead **and** the primary
 *   within `maxLagMs` (`replica-lag`): a thesis join reads the primary;
 *   search is stale on the replica up to `maxStaleMs`, then Unavailable.
 * - Outside it otherwise (`indexer-lag`: the primary is equal, or ahead but
 *   also outside `maxLagMs`): both stay on the replica, stale (search
 *   Unavailable past `maxStaleMs`). The primary gets no chain-join query.
 * - The primary cannot be probed or fails the join (`primary-unavailable`):
 *   the replica's answer, stale.
 * - Replica unreachable (`replica-unavailable`): a thesis join reads the
 *   primary; search is Unavailable; with the primary down too, both are
 *   Unavailable.
 * - No checkpoint anywhere yet (`no-checkpoint`): Unavailable.
 *
 * Only unavailability degrades; any other failure is a bug and is thrown.
 * The query must read chain identity through blast-infra's `chain_read_v1`
 * views, never its tables. The checkpoint is read just before the query, so
 * the answer is at least that recent.
 */
export async function readChainJoin<T>(
  resource: ReplicaResource,
  query: (database: ReadableDatabase) => Promise<T>,
  dependencies: ChainJoinDependencies = defaultDependencies(resource),
): Promise<RoutedRead<T>> {
  const policy: {
    maxLagMs: number;
    onLag: "stale" | "primary";
    maxStaleMs?: number;
  } = WORKLOAD_ROUTES[resource];
  const observedAt = dependencies.now();
  const replica = throughChainViews(dependencies.replica);
  const primaryDatabase = throughChainViews(dependencies.primary);

  const unavailable = (
    source: "replica" | "primary",
    position: ChainPosition | null,
    reason: string,
  ): RoutedRead<T> => {
    recordMetric("read.degraded", { resource, outcome: "unavailable", reason });
    return { status: "unavailable", provenance: provenance(source, position, observedAt, reason) };
  };
  /** The join on the primary, or null when the primary cannot serve it now. */
  /** The join on the primary; unavailable when the primary indexes another deployment. */
  const onPrimary = async (primary: ChainPosition, reason: string): Promise<RoutedRead<T> | null> => {
    const mismatch = deploymentMismatch(provenance("primary", primary, observedAt), dependencies.expected ?? null);
    if (mismatch) return unavailable("primary", primary, mismatch);
    let data: T;
    try {
      data = await query(primaryDatabase);
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) throw error;
      return null;
    }
    recordMetric("read.degraded", { resource, outcome: "primary", reason });
    return {
      status: primary.lagMs !== null && primary.lagMs <= policy.maxLagMs ? "fresh" : "stale",
      data,
      provenance: provenance("primary", primary, observedAt, reason),
    };
  };
  const probePrimary = async (): Promise<ChainPosition | null> => {
    try {
      return await dependencies.position("primary");
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) throw error;
      return null;
    }
  };
  const replicaDown = async (position: ChainPosition | null): Promise<RoutedRead<T>> => {
    if (policy.onLag !== "primary") return unavailable("replica", position, "replica-unavailable");
    const primary = await probePrimary();
    if (primary === null) return unavailable("replica", position, "replica-unavailable");
    if (primary.lagMs === null) return unavailable("primary", primary, "no-checkpoint");
    return (await onPrimary(primary, "replica-unavailable")) ??
      unavailable("replica", position, "replica-unavailable");
  };

  const staleReplica = async (position: ChainPosition, reason: LagReason): Promise<RoutedRead<T>> => {
    const withinCeiling = position.lagMs !== null &&
      (policy.onLag === "primary" || position.lagMs <= (policy.maxStaleMs ?? 0));
    if (!withinCeiling) return unavailable("replica", position, reason);
    let data: T;
    try {
      data = await query(replica);
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) throw error;
      return replicaDown(position);
    }
    recordMetric("read.degraded", { resource, outcome: "stale", reason, lagMs: position.lagMs });
    return { status: "stale", data, provenance: provenance("replica", position, observedAt, reason) };
  };

  let position: ChainPosition;
  try {
    position = await dependencies.position("replica");
    if (!position.inRecovery && dependencies.requireRecovery) {
      throw new Error("DATABASE_REPLICA_URL names a read-write compute, not the read replica.");
    }
    const mismatch = deploymentMismatch(provenance("replica", position, observedAt), dependencies.expected ?? null);
    if (mismatch) return unavailable("replica", position, mismatch);
    if (position.lagMs !== null && position.lagMs <= policy.maxLagMs) {
      return {
        status: "fresh",
        data: await query(replica),
        provenance: provenance("replica", position, observedAt),
      };
    }
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return replicaDown(null);
  }

  const primary = await probePrimary();
  const attributed = attributeLag(position, primary, policy.maxLagMs);
  let reason: LagReason = attributed.reason;
  if (policy.onLag === "primary" && attributed.primaryHelps && primary !== null) {
    const answer = await onPrimary(primary, reason);
    if (answer) return answer;
    reason = "primary-unavailable";
  }

  return staleReplica(position, reason);
}
