import { z } from "zod";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import type { ExecutedTrade, TradeRow } from "./swap.ts";

/** Actual output received by the sender, with wallet-paid SUI gas added back. */
export function filledOut(executed: ExecutedTrade, row: Pick<TradeRow, "sender" | "out_coin" | "fee_payer">): bigint {
  const sender = normalizeSuiAddress(row.sender);
  const change = executed.balanceChanges
    .filter((entry) => normalizeSuiAddress(entry.address) === sender && normalizeStructTag(entry.coinType) === row.out_coin)
    .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  const filled = row.out_coin === SOCIAL_TRADE_BASE_COINS.sui && row.fee_payer === "wallet" ? change + executed.gasMist : change;
  return filled < 0n ? 0n : filled;
}

export const INSERT_SWAP_RECEIPT_SQL = `INSERT INTO social_swap_receipts (trade_id, timestamp_ms, checkpoint, success, amount_out)
  SELECT trade_id, $2::bigint, $3::bigint, $4::boolean, $5::numeric
  FROM social_swap_intents WHERE trade_id = $1::uuid AND track_receipt
  ON CONFLICT (trade_id) DO NOTHING`;

/** Persist checkpointed outcomes once; only successes carry a bought amount. */
export async function recordSwapReceipt(
  social: ModuleTransaction<"social">,
  row: TradeRow,
  executed: ExecutedTrade | null,
): Promise<boolean> {
  if (!executed || !row.digest || normalizeSuiAddress(executed.sender) !== normalizeSuiAddress(row.sender)) {
    return false;
  }
  const timestamp = executed.timestampMs;
  const checkpoint = executed.checkpoint;
  if (!z.object({ timestamp: z.number().int().positive(), checkpoint: z.string().regex(/^(0|[1-9][0-9]*)$/) }).safeParse({ timestamp, checkpoint }).success) {
    return false;
  }
  const amount = executed.success ? filledOut(executed, row) : null;
  if (amount !== null && (amount <= 0n || amount < BigInt(row.min_out))) {
    return false;
  }

  const result = await social.write("social_swap_receipts", INSERT_SWAP_RECEIPT_SQL, [row.trade_id, timestamp, checkpoint, executed.success, amount?.toString() ?? null]);
  return result.rowCount === 1;
}
