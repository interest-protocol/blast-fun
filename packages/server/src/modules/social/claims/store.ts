import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { vestingMsSql, vestingStepsSql } from "@blast/core/modules/social/contracts/vesting.ts";
import {
  TRANSACTION_COLUMNS,
  type TransactionRow,
} from "@blast/core/modules/social/transactions/log.ts";
/** The attempt by its id (the log's primary key). */
export const CLAIM_ROW_SQL = `SELECT ${TRANSACTION_COLUMNS} FROM social_transactions WHERE tx_id = $1::uuid`;

/**
 * The Blast wallet's position in one shown sale, by the two views' keys
 * (`presales` by `presale_id`, `presale_positions` by `(presale_id,
 * wallet)`): what is open to claim is read here, never taken from the client.
 */
export const CLAIM_POSITION_SQL = `SELECT p.lifecycle, pos.commitment::text AS commitment, pos.claim_digest
  FROM ${SHOWN_PRESALES} p
  JOIN chain_read_v1.presale_positions pos ON pos.presale_id = p.presale_id
  WHERE p.presale_id = $1 AND pos.wallet = $2`;
assertChainReadThroughViews(CLAIM_POSITION_SQL);

/**
 * A vesting schedule of one shown sale paying the Blast wallet (P-13), by the
 * view's key (`schedule_id`): what it has vested is read here, never taken
 * from the client.
 */
const CLAIM_VESTING_SQL = `SELECT v.total::text AS total, v.claimed::text AS claimed, v.start_ms::text AS start_ms,
    ${vestingMsSql("v.start_ms + v.cliff_ms")} AS cliff_end_ms, ${vestingMsSql("v.end_ms")} AS end_ms, ${vestingStepsSql("v")}
  FROM chain_read_v1.vesting_schedules v
  JOIN ${SHOWN_PRESALES} p ON p.presale_id = v.presale_id
  WHERE v.schedule_id = $1 AND v.presale_id = $2 AND v.beneficiary = $3`;
assertChainReadThroughViews(CLAIM_VESTING_SQL);

export type VestingRow = Readonly<{
  total: string;
  claimed: string;
  start_ms: string;
  cliff_end_ms: string;
  end_ms: string;
  period_ms: string | null;
  periods: string | null;
}>;

export type PositionRow = Readonly<{
  lifecycle: string;
  commitment: string;
  claim_digest: string | null;
}>;

export async function findClaim(
  database: ReadableDatabase,
  requestId: string,
): Promise<TransactionRow | null> {
  return (await database.read<TransactionRow>(CLAIM_ROW_SQL, [requestId])).rows[0] ?? null;
}
export async function findClaimPosition(
  database: ReadableDatabase,
  presaleId: string,
  participant: string,
): Promise<PositionRow | null> {
  return (
    (await database.read<PositionRow>(CLAIM_POSITION_SQL, [presaleId, participant])).rows[0] ?? null
  );
}
export async function findClaimVesting(
  database: ReadableDatabase,
  scheduleId: string,
  presaleId: string,
  participant: string,
): Promise<VestingRow | null> {
  return (
    (await database.read<VestingRow>(CLAIM_VESTING_SQL, [scheduleId, presaleId, participant]))
      .rows[0] ?? null
  );
}
export async function shownSaleHasMigrated(
  database: ReadableDatabase,
  presaleId: string,
): Promise<boolean> {
  return (
    (
      await database.read(
        `SELECT presale_id FROM ${SHOWN_PRESALES} WHERE presale_id = $1 AND lifecycle = 'migrated'`,
        [presaleId],
      )
    ).rows.length > 0
  );
}
