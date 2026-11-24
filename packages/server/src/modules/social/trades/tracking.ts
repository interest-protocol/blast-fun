import type { ReadableDatabase, ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { TRADE_COLUMNS, type TradeLookup, type TradeRow } from "./swap.ts";
import { recordSwapReceipt } from "./receipts.ts";

export type SwapTrackingCursor = Readonly<{ createdAtMs: string; tradeId: string }>;

const CANDIDATES_SQL = `SELECT ${TRADE_COLUMNS} FROM social_swap_intents
  WHERE digest IS NOT NULL AND track_receipt
    AND (created_at_ms, trade_id) > ($1::bigint, $2::uuid)
    AND NOT EXISTS (SELECT 1 FROM social_swap_receipts r WHERE r.trade_id = social_swap_intents.trade_id)
  ORDER BY created_at_ms, trade_id LIMIT $3`;

/** Recover outcomes even when the browser closed before calling settle. One bounded page, serial RPCs. */
export async function collectSwapReceipts(deps: Readonly<{
  database: ReadableDatabase;
  transactions: TradeLookup;
  transaction: <T>(operation: (social: ModuleTransaction<"social">) => Promise<T>) => Promise<T>;
}>, after?: SwapTrackingCursor) {
  const { rows } = await deps.database.read<TradeRow>(CANDIDATES_SQL, [
    after?.createdAtMs ?? "0", after?.tradeId ?? "00000000-0000-0000-0000-000000000000", 100,
  ]);
  let recorded = 0;
  let failed = 0;
  let unavailable = 0;
  let pending = 0;
  for (const row of rows) {
    let executed;
    try {
      executed = await deps.transactions.executed(row.digest!, AbortSignal.timeout(5_000));
    } catch {
      unavailable += 1;
      continue;
    }
    if (!executed || executed.timestampMs == null || executed.checkpoint == null) {
      pending += 1;
      continue;
    }
    if (await deps.transaction((social) => recordSwapReceipt(social, row, executed))) {
      if (executed.success) {
        recorded += 1;
      } else {
        failed += 1;
      }
    }
  }
  const last = rows.at(-1);
  return {
    scanned: rows.length,
    recorded,
    failed,
    unavailable,
    pending,
    next: rows.length === 100 && last ? { createdAtMs: last.created_at_ms, tradeId: last.trade_id } : null,
  };
}

/** All output coins, including SUI/USDC from sells. Values are exact strings; USD is a submission-time estimate. */
export const EXPORT_SWAP_RECEIPTS_SQL = `SELECT i.trade_id::text, i.digest, i.sender,
    i.out_coin AS bought_coin, r.amount_out::text AS bought_amount_atoms,
    i.in_coin AS paid_coin, i.amount_in::text AS paid_amount_atoms,
    r.timestamp_ms::text, r.checkpoint::text,
    i.usd_value::text AS usd_value,
    CASE WHEN i.usd_value IS NOT NULL THEN 'input_value_at_submission' ELSE NULL END AS usd_basis
  FROM social_swap_receipts r JOIN social_swap_intents i USING (trade_id)
  WHERE r.success AND r.timestamp_ms >= $1::bigint AND r.timestamp_ms < $2::bigint
    AND (r.timestamp_ms, r.trade_id) > ($3::bigint, $4::uuid)
  ORDER BY r.timestamp_ms, r.trade_id LIMIT 100`;
