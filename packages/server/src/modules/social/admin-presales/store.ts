import type { Pool } from "pg";
import { autocommitReader, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import {
  SHOWN_PRESALES,
  pinnablePresaleSql,
} from "@blast/core/modules/social/read-model/chain-presales.ts";
const PINNABLE_PRESALES = `(SELECT * FROM ${SHOWN_PRESALES} p
  WHERE ${pinnablePresaleSql("p", "$1::bigint")})`;

export async function readPinnablePresales(
  pool: Pool,
  input: Readonly<{
    nowMs: number;
    id: string | null;
    after: string | null;
    limit: number;
  }>,
) {
  const { rows } = await autocommitReader(pool, "social").read(
    `SELECT p.presale_id, p.sale_name AS name, p.sale_symbol AS symbol, p.lifecycle,
       (pin.presale_id IS NOT NULL) AS pinned
     FROM ${PINNABLE_PRESALES} p LEFT JOIN social_presale_pins pin USING (presale_id)
     WHERE ($2::text IS NULL OR p.presale_id = $2) AND ($3::text IS NULL OR p.presale_id > $3)
     ORDER BY p.presale_id LIMIT $4`,
    [input.nowMs, input.id, input.after, input.limit],
  );
  return rows;
}
export async function setPresalePin(
  pool: Pool,
  presaleId: string,
  pinned: boolean,
  nowMs: number,
): Promise<boolean> {
  const result = pinned
    ? await autocommitWrite(
        pool,
        "social",
        "social_presale_pins",
        `INSERT INTO social_presale_pins (presale_id)
       SELECT presale_id FROM ${PINNABLE_PRESALES} p WHERE presale_id = $2
       ON CONFLICT DO NOTHING`,
        [nowMs, presaleId],
      )
    : await autocommitWrite(
        pool,
        "social",
        "social_presale_pins",
        "DELETE FROM social_presale_pins WHERE presale_id = $1",
        [presaleId],
      );
  if (pinned && result.rowCount === 0) {
    const existing = await autocommitReader(pool, "social").read(
      `SELECT 1 FROM social_presale_pins pin JOIN ${PINNABLE_PRESALES} p USING (presale_id)
       WHERE pin.presale_id = $2`,
      [nowMs, presaleId],
    );
    return existing.rowCount !== 0;
  }
  return true;
}
