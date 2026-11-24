import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
export async function presaleExists(social: ReadableDatabase, presaleId: string): Promise<boolean> {
  const result = await social.read(`SELECT 1 FROM ${SHOWN_PRESALES} WHERE presale_id = $1`, [
    presaleId,
  ]);
  return result.rowCount !== null && result.rowCount > 0;
}
