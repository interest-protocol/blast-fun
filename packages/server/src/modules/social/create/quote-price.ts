import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  CREATE_SUI_QUOTE_TYPE,
  quotePriceType,
  type CreateQuotePrice,
} from "@blast/core/modules/social/contracts/create.ts";
import { optionalSource } from "../optional-source.ts";
const PRICE_SQL = `SELECT usd_price::text AS usd_price, as_of_ms::text AS as_of_ms FROM chain_read_v1.prices WHERE coin_type = $1`;

/** R3-42: the SUI row the picker converts at, read with `db`; null without one. */
export function readSuiQuotePrice(
  db: ReadableDatabase | (() => ReadableDatabase),
): Promise<CreateQuotePrice | null> {
  return readCreateQuotePrice(db, CREATE_SUI_QUOTE_TYPE);
}

export function readCreateQuotePrice(
  db: ReadableDatabase | (() => ReadableDatabase),
  quoteType: string,
): Promise<CreateQuotePrice | null> {
  return optionalSource(
    quoteType === CREATE_SUI_QUOTE_TYPE ? "sui_quote_price" : "create_quote_price",
    () => readPrice(typeof db === "function" ? db() : db, quotePriceType(quoteType)),
    null,
  );
}

async function readPrice(db: ReadableDatabase, coinType: string): Promise<CreateQuotePrice | null> {
  const { rows } = await db.read<{
    usd_price: string | null;
    as_of_ms: string | null;
  }>(PRICE_SQL, [coinType]);
  const row = rows[0];
  return row?.usd_price && row.as_of_ms !== null && Number(row.usd_price) > 0
    ? { usd_price: row.usd_price, as_of_ms: Number(row.as_of_ms) }
    : null;
}
