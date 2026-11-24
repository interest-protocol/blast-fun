import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
// Durable per-vault buyback schedules for both launch products. Chain reads
// remain authoritative for balances and execution outcomes.
import type { Pool } from "pg";
import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";

const MODULE = "vault-buyback";
const TABLE = "mission_control_vault_buybacks";
export const BUYBACK_JOB = "vault-buyback";
export type BuybackVenue = MigratorVenue;
export type BuybackState = "idle" | "waiting" | "submitted" | "done";
export type DiscoveredVault = Readonly<{
  vaultId: string;
  originId: string;
  packageWitness: string;
  venueType: string;
  memeType: string;
  quoteType: string;
  poolTickSpacing: number;
  poolFeeRate: bigint | null;
  venue: BuybackVenue;
  poolId: string;
}>;
export type BuybackRow = DiscoveredVault & Readonly<{
  network: string;
  planDay: string | null;
  runAt: Date | null;
  state: BuybackState;
  latestDigest: string | null;
  attempts: number;
  minOutAborts: number;
  piecesToday: number;
}>;

export async function recordVaults(pool: Pool, network: string, vaults: readonly DiscoveredVault[]): Promise<number> {
  let recorded = 0;
  for (const vault of vaults) {
    const { rowCount } = await autocommitWrite(pool, MODULE, TABLE,
      `INSERT INTO mission_control_vault_buybacks
        (network,vault_id,origin_id,package_witness,venue_type,meme_type,quote_type,pool_tick_spacing,pool_fee_rate,venue,pool_id,state,detected_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'idle',now(),now())
       ON CONFLICT (network,vault_id) DO NOTHING`,
      [network,vault.vaultId,vault.originId,vault.packageWitness,vault.venueType,vault.memeType,vault.quoteType,
       vault.poolTickSpacing,vault.poolFeeRate?.toString() ?? null,vault.venue,vault.poolId]);
    recorded += rowCount ?? 0;
  }
  return recorded;
}

/** Vaults and no plan for `day` (and nothing in flight), at most `limit`. */
export async function unplanned(pool: Pool, network: string, day: string, limit: number): Promise<string[]> {
  const { rows } = await autocommitRead<{ vault_id: string }>(
    pool,
    MODULE,
    `SELECT vault_id FROM mission_control_vault_buybacks
     WHERE network = $1 AND vault_id IS NOT NULL AND state <> 'submitted'
       AND (plan_day IS NULL OR plan_day < $2::date)
     ORDER BY vault_id
     LIMIT $3`,
    [network, day, limit],
  );
  return rows.map((row) => row.vault_id);
}

/** Stores `day`'s drawn run time for one vault, unless it was planned meanwhile or is in flight. */
export async function planDay(pool: Pool, network: string, vaultId: string, day: string, runAt: Date): Promise<boolean> {
  const { rowCount } = await autocommitWrite(
    pool,
    MODULE,
    TABLE,
    `UPDATE mission_control_vault_buybacks
     SET plan_day = $3::date, run_at = $4, next_eligible_at = NULL, state = 'waiting', outcome = NULL, attempts = 0, pieces_today = 0,
         updated_at = now()
     WHERE network = $1 AND vault_id = $2 AND vault_id IS NOT NULL AND state <> 'submitted'
       AND (plan_day IS NULL OR plan_day < $3::date)`,
    [network, vaultId, day, runAt],
  );
  return rowCount === 1;
}

type Row = {
  network: string;
  vault_id: string;
  meme_type: string;
  quote_type: string;
  venue_type: string;
  pool_tick_spacing: number;
  pool_fee_rate: string | null;
  venue: BuybackVenue;
  pool_id: string;
  origin_id: string;
  package_witness: string;
  plan_day: string | null;
  run_at: Date | null;
  state: BuybackState;
  latest_digest: string | null;
  attempts: number;
  min_out_aborts: number;
  pieces_today: number;
};

/**
 * Rows whose turn has come: today's plan past its drawn time and any retry
 * delay, and every submission still to settle. At most `limit`, earliest
 * first; the job shuffles them.
 */
export async function dueRows(pool: Pool, network: string, day: string, now: Date, limit: number): Promise<BuybackRow[]> {
  const { rows } = await autocommitRead<Row>(
    pool,
    MODULE,
    `SELECT network, origin_id, package_witness, meme_type, quote_type, venue_type, pool_tick_spacing, pool_fee_rate::text,
            venue, pool_id, vault_id, plan_day::text, run_at, state, latest_digest, attempts, min_out_aborts, pieces_today
     FROM mission_control_vault_buybacks
     WHERE network = $1 AND vault_id IS NOT NULL
       AND ((state = 'waiting' AND plan_day = $2::date AND run_at <= $3) OR state = 'submitted')
       AND (next_eligible_at IS NULL OR next_eligible_at <= $3)
     ORDER BY run_at, vault_id
     LIMIT $4`,
    [network, day, now, limit],
  );
  return rows.map((row) => ({
    network: row.network,
    originId: row.origin_id,
    packageWitness: row.package_witness,
    memeType: row.meme_type,
    quoteType: row.quote_type,
    venueType: row.venue_type,
    poolTickSpacing: row.pool_tick_spacing,
    poolFeeRate: row.pool_fee_rate === null ? null : BigInt(row.pool_fee_rate),
    venue: row.venue,
    poolId: row.pool_id,
    vaultId: row.vault_id,
    planDay: row.plan_day,
    runAt: row.run_at,
    state: row.state,
    latestDigest: row.latest_digest,
    attempts: row.attempts,
    minOutAborts: row.min_out_aborts,
    piecesToday: row.pieces_today,
  }));
}

/** The digest about to be sent, recorded first: a crash after sending still names what may have landed. */
export async function recordSubmitted(pool: Pool, row: BuybackRow, digest: string): Promise<boolean> {
  const { rowCount } = await autocommitWrite(
    pool,
    MODULE,
    TABLE,
    `UPDATE mission_control_vault_buybacks
     SET state = 'submitted', latest_digest = $3, attempts = attempts + 1, outcome = 'submitted', updated_at = now()
     WHERE network = $1 AND vault_id = $2 AND state IN ('waiting', 'submitted')`,
    [row.network, row.vaultId, digest],
  );
  return rowCount === 1;
}

/**
 * A piece of ours landed: totals added, the abort streak reset, and either the
 * next piece's drawn time (`nextRunAt`) or done for the day.
 */
export async function recordExecuted(
  pool: Pool,
  row: BuybackRow,
  burned: Readonly<{ quoteSpent: bigint; memeBurned: bigint }>,
  nextRunAt: Date | null,
): Promise<void> {
  await autocommitWrite(
    pool,
    MODULE,
    TABLE,
    `UPDATE mission_control_vault_buybacks
     SET state = CASE WHEN $5::timestamptz IS NULL THEN 'done' ELSE 'waiting' END,
         run_at = coalesce($5::timestamptz, run_at), outcome = 'executed', next_eligible_at = NULL, min_out_aborts = 0,
         pieces_today = pieces_today + 1,
         quote_spent_total = quote_spent_total + $3::numeric, meme_burned_total = meme_burned_total + $4::numeric,
         last_executed_at = now(), updated_at = now()
     WHERE network = $1 AND vault_id = $2`,
    [row.network, row.vaultId, burned.quoteSpent.toString(), burned.memeBurned.toString(), nextRunAt],
  );
}

/**
 * Ends a visit without a buyback: `done` for the day, or `waiting` until
 * `nextEligibleAt`. A `min_meme_out` abort extends the vault's streak, any
 * other outcome keeps it. Returns the streak after the visit.
 */
export async function recordVisit(
  pool: Pool,
  row: BuybackRow,
  visit: Readonly<{ outcome: string; done: boolean; nextEligibleAt: Date | null; minOutAbort?: boolean }>,
): Promise<number> {
  const { rows } = await autocommitWrite<"vault-buyback", { min_out_aborts: number }>(
    pool,
    MODULE,
    TABLE,
    `UPDATE mission_control_vault_buybacks
     SET state = $3, outcome = $4, next_eligible_at = $5,
         min_out_aborts = CASE WHEN $6::boolean THEN min_out_aborts + 1 ELSE min_out_aborts END,
         updated_at = now()
     WHERE network = $1 AND vault_id = $2
     RETURNING min_out_aborts`,
    [row.network, row.vaultId, visit.done ? "done" : "waiting", visit.outcome, visit.nextEligibleAt, visit.minOutAbort ?? false],
  );
  return rows[0]?.min_out_aborts ?? row.minOutAborts;
}
