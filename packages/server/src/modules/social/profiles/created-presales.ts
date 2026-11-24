import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";

/** Chain creator matches use only uncontested wallets; verified publications survive wallet unlinking. */
export async function readCreatedPresaleIds(
  db: ReadableDatabase,
  accountId: string,
  addresses: readonly string[],
): Promise<string[]> {
  const { rows } = await db.read<{ presale_id: string }>(
    `
    SELECT presale_id FROM (
      SELECT d.published_presale_id AS presale_id, d.published_at, NULL::bigint AS updated_checkpoint
      FROM social_presale_drafts d
      WHERE d.account_id = $1 AND d.published_presale_id IS NOT NULL
      UNION ALL
      SELECT s.presale_id, NULL::timestamptz, s.updated_checkpoint
      FROM ${SHOWN_PRESALES} s
      WHERE s.creator = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM social_presale_drafts d WHERE d.account_id = $1 AND d.published_presale_id = s.presale_id)
    ) AS created
    ORDER BY published_at DESC NULLS LAST, updated_checkpoint DESC, presale_id DESC
    LIMIT 200`,
    [accountId, addresses],
  );
  // shortcut: shows up to 200 created presales; add paging when creators reach that limit.
  return rows.map((row) => row.presale_id);
}
