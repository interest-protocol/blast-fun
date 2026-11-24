import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { BLAST_LAUNCH_COINS } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";
import { COST_BASIS_KINDS, COST_BASIS_ROWS_PER_WALLET, type CostBasisLedger, type CostBasisRow } from "@blast/server/modules/social/portfolio/cost-basis.ts";

/** All indexed venues, bounded per wallet. The accounting key is the coin's original launch ID. */
export async function readPnlLedger(db: ReadableDatabase, wallets: readonly string[]): Promise<CostBasisLedger> {
  const { rows: period } = await db.read<{ first_checkpoint: string }>("SELECT first_checkpoint::text FROM chain_read_v1.blast_pnl_period");
  if (period.length !== 1) throw new SocialRouteError("service_unavailable");
  const addresses = [...new Set(wallets)];
  if (addresses.length === 0) return { rows: [], truncated: false };
  type LedgerRow = Omit<CostBasisRow, "presale_id"> & { presale_id: string | null };
  const { rows } = await db.read<LedgerRow>(`SELECT a.kind, a.accounting_complete, c.asset_id AS presale_id,
      a.actor, a.quote_amount::text AS quote_amount, a.coin_amount::text AS coin_amount,
      a.quote_refund::text AS quote_refund, a.usd_value::text AS usd_value,
      a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
    FROM unnest((SELECT $1::text[])) AS w(address)
    CROSS JOIN LATERAL (
      SELECT * FROM chain_read_v1.blast_pnl_activity a
      WHERE a.actor = w.address AND a.kind = ANY($2::text[])
      ORDER BY a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
      LIMIT $3
    ) a
    LEFT JOIN (
      SELECT c.asset_id, k.lookup_key FROM ${BLAST_LAUNCH_COINS} c
      CROSS JOIN LATERAL unnest(array_remove(ARRAY[c.presale_id, c.coin_type], NULL)) AS k(lookup_key)
    ) c ON c.lookup_key = coalesce(a.presale_id, a.coin_type)
    ORDER BY a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part`,
  [addresses, [...COST_BASIS_KINDS, "pnl_opening_balance", "pnl_opening_commitment"], COST_BASIS_ROWS_PER_WALLET + 1]);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.actor, (counts.get(row.actor) ?? 0) + 1);
  // Count the bounded raw history before dropping hidden or unrecognized origins.
  const scoped = rows.flatMap((row) => row.presale_id === null ? [] : [{ ...row, presale_id: row.presale_id }]);
  return { rows: scoped, truncated: [...counts.values()].some((count) => count > COST_BASIS_ROWS_PER_WALLET) };
}
