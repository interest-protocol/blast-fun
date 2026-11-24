import type { SuiGraphQLClient } from "@mysten/sui/graphql";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { assertChainReadThroughViews } from "../database/modules.ts";
import { assertReadOnlyStatement } from "../database/transaction.ts";
import { DefillamaAccounting, type NativeEvent } from "./accounting.ts";
import type { ReplayBase } from "./store.ts";
import { collectFrontendFees } from "./frontend-source.ts";
import {
  HOUR_SECONDS,
  dayInterval,
  hourStarts,
  METHODOLOGY,
  type FrontendFeePolicy,
  type Profile,
  type Snapshot,
} from "./contracts.ts";

const BATCH = 500;
// A first publication or rebuild may need a bounded replay from the deployment floor.
const MAX_EVENTS = 1_000_000;

type CollectOptions = {
  archive?: Pick<SuiGraphQLClient, "query">;
  frontendFeeHistory?: readonly FrontendFeePolicy[];
  replayBase?: ReplayBase;
  sourceFingerprint?: string;
};

// Keep coverage checks and receipt pages on the same repeatable-read snapshot.
function readSource<Row extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values?: unknown[],
) {
  assertReadOnlyStatement(text);
  assertChainReadThroughViews(text);
  return client.query<Row>(text, values);
}

export function collectDay(
  source: Pool,
  profile: Profile,
  date: string,
  now = Date.now(),
  options: CollectOptions = {},
): Promise<Snapshot> {
  return collectInterval(source, profile, date, dayInterval(date, now), options);
}

export function collectHour(
  source: Pool,
  profile: Profile,
  start: number,
  now: number,
  options: CollectOptions,
): Promise<Snapshot> {
  const end = start + HOUR_SECONDS;
  hourStarts(start, end, now);
  return collectInterval(
    source,
    profile,
    new Date(start * 1000).toISOString().slice(0, 10),
    {
      start: start * 1000,
      end: end * 1000,
    },
    options,
  );
}

async function collectInterval(
  source: Pool,
  profile: Profile,
  date: string,
  { start, end }: { start: number; end: number },
  options: CollectOptions,
): Promise<Snapshot> {
  const client = await source.connect();
  const accounting = new DefillamaAccounting(profile, start, end);
  let cut: Snapshot["source"];
  let firstCheckpoint: number;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const base = options.replayBase;
    const fromCheckpoint = base?.source.checkpoint ?? profile.first_checkpoint;
    if (BigInt(fromCheckpoint) < BigInt(profile.first_checkpoint)) {
      throw new Error("Replay base is outside the verified source interval");
    }
    cut = await requireSourceCut(
      client, profile, start, end, fromCheckpoint,
      options.sourceFingerprint ?? profile.deployment_fingerprint,
    );
    if (base) {
      const verified = await readSource<{ digest: string }>(
        client,
        "SELECT digest FROM chain_read_v1.checkpoint_headers WHERE checkpoint=$1",
        [fromCheckpoint],
      );
      if (verified.rows[0]?.digest !== base.source.digest) throw new Error("Replay base cut is unavailable");
      accounting.restore(base.state, base.contracts);
    }
    const first = await readSource<{ checkpoint: string }>(
      client,
      `SELECT checkpoint FROM chain_read_v1.checkpoint_headers
       WHERE checkpoint BETWEEN $1 AND $2 AND timestamp_ms >= $3 ORDER BY checkpoint LIMIT 1`,
      [fromCheckpoint, cut.checkpoint, start],
    );
    firstCheckpoint = Number(first.rows[0]?.checkpoint);
    if (!Number.isSafeInteger(firstCheckpoint) || firstCheckpoint <= 0) {
      throw new Error("Cannot establish the first checkpoint of the interval");
    }
    await replayReceipts(client, profile, fromCheckpoint, cut.checkpoint, end, accounting);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const frontend = await collectFrontendFees(options.archive, options.frontendFeeHistory ?? [], firstCheckpoint, cut);
  accounting.addFrontendFees(frontend.fees);
  const result = accounting.result();
  if (frontend.coverage.status === "unavailable") {
    for (const metric of ["fees", "revenue", "protocol_revenue"] as const) {
      if (result.coverage[metric].status === "complete") result.coverage[metric] = frontend.coverage;
      result.scope_coverage.frontend_router[metric] = frontend.coverage;
    }
  }
  return {
    schema_version: 1,
    chain: "sui",
    date,
    start_timestamp: start / 1000,
    end_timestamp: end / 1000,
    methodology_version: METHODOLOGY,
    profile,
    source: cut,
    frontend_fee_coverage: frontend.coverage,
    frontend_fee_policy: frontend.policy,
    native_replay: accounting.replayState(),
    ...result,
  };
}

async function requireSourceCut(
  client: PoolClient,
  profile: Profile,
  start: number,
  end: number,
  fromCheckpoint: string,
  sourceFingerprint: string,
): Promise<Snapshot["source"]> {
  const recovery = await readSource<{ replica: boolean }>(
    client,
    "SELECT pg_is_in_recovery() AS replica",
  );
  if (!recovery.rows[0]?.replica) {
    throw new Error("DefiLlama source must be a physical read replica");
  }
  const first = await readSource<{ timestamp_ms: string }>(
    client,
    "SELECT timestamp_ms FROM chain_read_v1.checkpoint_headers WHERE checkpoint = $1",
    [profile.first_checkpoint],
  );
  const historyStart = Number(first.rows[0]?.timestamp_ms);
  if (!Number.isSafeInteger(historyStart) || historyStart > start) {
    throw new Error("Interval precedes verified history");
  }
  const head = await readSource<{ first_checkpoint: string; checkpoint: string }>(
    client,
    "SELECT first_checkpoint, checkpoint FROM chain_read_v1.projection_coverage WHERE pipeline = 'intake' AND network = $1 AND deployment_fingerprint = $2",
    [profile.network, sourceFingerprint],
  );
  const coverage = head.rows[0];
  if (
    !coverage ||
    coverage.checkpoint === null ||
    BigInt(coverage.first_checkpoint) > BigInt(profile.first_checkpoint)
  ) {
    throw new Error("Native history does not cover the deployment start");
  }
  const cuts = await readSource<{ checkpoint: string; digest: string; timestamp_ms: string }>(
    client,
    `SELECT checkpoint, digest, timestamp_ms FROM chain_read_v1.checkpoint_headers
     WHERE checkpoint >= $1 AND checkpoint <= $2 AND timestamp_ms >= $3 ORDER BY checkpoint LIMIT 1`,
    [fromCheckpoint, coverage.checkpoint, end],
  );
  const cut = cuts.rows[0];
  if (!cut) {
    throw new Error("Native ingestion has not completed the interval");
  }
  await readSource(client, "SELECT chain_read_v1.require_cut($1,$2,$3,$4,ARRAY['intake']::TEXT[])", [
    profile.network,
    sourceFingerprint,
    cut.checkpoint,
    cut.digest,
  ]);
  return {
    checkpoint: cut.checkpoint,
    digest: cut.digest,
    timestamp_ms: Number(cut.timestamp_ms),
    history_start_ms: historyStart,
  };
}

async function replayReceipts(
  client: PoolClient,
  profile: Profile,
  fromCheckpoint: string,
  checkpoint: string,
  end: number,
  accounting: DefillamaAccounting,
): Promise<void> {
  let cursor = [fromCheckpoint, "0", "-1"];
  let seen = 0;
  while (true) {
    const page = await readSource<NativeEvent>(
      client,
      `SELECT checkpoint, tx_slot, event_slot, timestamp_ms, tx_digest, sender, event_type,
              CASE WHEN octet_length(bcs) <= 262144 THEN bcs ELSE NULL END AS bcs
       FROM chain_read_v1.defillama_events
       WHERE (checkpoint, tx_slot, event_slot) > ($1::BIGINT,$2::BIGINT,$3::BIGINT)
         AND checkpoint <= $4 AND timestamp_ms < $5
         AND event_type LIKE ANY($6::TEXT[])
       ORDER BY checkpoint, tx_slot, event_slot LIMIT ${BATCH}`,
      [
        ...cursor,
        checkpoint,
        end,
        [
          `${profile.launchpad_original_package}::events::%`,
          `${profile.presale_original_package}::blast_presale::PresaleCreated<%`,
          `${profile.vault_original_package}::blast_vault_events::%`,
          `${profile.core_original_package}::blast_core_events::ProtocolFeesPaid<%`,
          `${profile.admin_original_package}::delayed::DelayedApplied<${profile.vault_original_package}::vault::FeeSplitKey,%`,
        ],
      ],
    );
    seen += page.rows.length;
    if (seen > MAX_EVENTS) {
      throw new Error("DefiLlama replay limit reached; no publication was made");
    }
    for (const row of page.rows) {
      accounting.apply(row);
    }
    const last = page.rows.at(-1);
    if (page.rows.length < BATCH || !last) {
      return;
    }
    cursor = [last.checkpoint, last.tx_slot, last.event_slot];
  }
}
