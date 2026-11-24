import { explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  SOCIAL_TRANSACTIONS_PAGE_DEFAULT,
  SOCIAL_TRANSACTIONS_PAGE_MAX,
  type SocialTransaction,
  type SocialTransactionsPage,
} from "@blast/core/modules/social/contracts/transactions.ts";
import { DEFAULT_SOCIAL_EXPLORER, isSocialExplorer, type SocialExplorer } from "@blast/core/modules/social/contracts/settings.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { TransactionRow } from "@blast/core/modules/social/transactions/log.ts";

/** A page cursor: the last row's `created_at_ms` (a decimal string) and `tx_id`. */
export type TransactionsCursor = Readonly<{ createdAtMs: string; txId: string }>;
export type TransactionsQuery = Readonly<{ limit: number; cursor: TransactionsCursor | null }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MS = /^[1-9][0-9]{0,18}$/;

export function encodeTransactionsCursor(cursor: TransactionsCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAtMs, cursor.txId])).toString("base64url");
}

/** A cursor from `encodeTransactionsCursor`, or `invalid_parameter` (`cursor`). */
const transactionsCursorSchema = z.tuple([
  z.string().regex(MS).pipe(z.string().refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)),
  z.string().regex(UUID),
]);

export function decodeTransactionsCursor(raw: string): TransactionsCursor {
  let parsed: unknown = null;
  if (raw.length <= 200) {
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  const decoded = transactionsCursorSchema.safeParse(parsed);
  if (!decoded.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
  return { createdAtMs: decoded.data[0], txId: decoded.data[1] };
}

/** `limit` (1 to 50, default 30) and `cursor` of a list URL, each at most once; others ignored. */
export function parseTransactionsQuery(url: URL): TransactionsQuery {
  const one = (name: string) => socialSingle(url.searchParams, name);
  const rawLimit = one("limit");
  const limit = socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(SOCIAL_TRANSACTIONS_PAGE_MAX)).nullable().transform((value) => value ?? SOCIAL_TRANSACTIONS_PAGE_DEFAULT), rawLimit, "limit");
  const rawCursor = one("cursor");
  return { limit, cursor: rawCursor === null ? null : decodeTransactionsCursor(rawCursor) };
}

/**
 * One page of an account's log and the account's explorer, in one statement
 * on the primary. The rows come from `social_transactions_account_idx`
 * (`account_id, created_at_ms DESC, tx_id`) in index order with the keyset
 * in the index condition (`created_at_ms <= $2`) and its tie-break as a
 * filter, never OFFSET; `$n` is the page size plus one, so the page knows
 * whether another follows. A withdrawal's recipient joins its
 * `social_coin_transfers` record on the primary key (the row's `tx_id` is
 * the transfer's request id). The account row answers even when the log is
 * empty, so the page always names its explorer.
 */
function pageSql(after: boolean): string {
  const keyset = after ? "AND s.created_at_ms <= $2::bigint AND (s.created_at_ms < $2::bigint OR s.tx_id > $3::uuid)" : "";
  const limit = after ? "$4" : "$2";
  return `
  SELECT a.explorer, t.tx_id::text AS tx_id, t.account_id::text AS account_id, t.kind, t.state, t.digest, t.failure_code, t.presale_id,
    t.coin_type, t.amount::text AS amount, t.quote_type, t.quote_amount::text AS quote_amount, t.usd_value::text AS usd_value,
    t.idempotency_key, t.created_at_ms::text AS created_at_ms, t.settled_at_ms::text AS settled_at_ms, c.recipient
  FROM social_accounts a
  LEFT JOIN LATERAL (
    SELECT s.* FROM social_transactions s
    WHERE s.account_id = a.account_id ${keyset}
    ORDER BY s.created_at_ms DESC, s.tx_id
    LIMIT ${limit}
  ) t ON TRUE
  LEFT JOIN social_coin_transfers c ON t.kind = 'withdraw' AND c.request_id = t.tx_id
  WHERE a.account_id = $1::uuid
  ORDER BY t.created_at_ms DESC, t.tx_id`;
}

export const TRANSACTIONS_FIRST_PAGE_SQL = pageSql(false);
export const TRANSACTIONS_NEXT_PAGE_SQL = pageSql(true);

/** The account's explorer, then its logged row (every column null on an empty page) and a withdrawal's recipient. */
type PageRow = Omit<TransactionRow, "tx_id"> & Readonly<{ tx_id: string | null; explorer: string; recipient: string | null }>;
type LoggedRow = TransactionRow & Readonly<{ recipient: string | null }>;

function transactionBody(row: LoggedRow, explorer: SocialExplorer): SocialTransaction {
  return {
    tx_id: row.tx_id,
    kind: row.kind,
    state: row.state,
    digest: row.digest,
    failure_code: row.failure_code,
    presale_id: row.presale_id,
    coin_type: row.coin_type,
    amount: row.amount,
    quote_type: row.quote_type,
    quote_amount: row.quote_amount,
    usd_value: row.usd_value,
    recipient: row.kind === "withdraw" ? row.recipient : null,
    created_at_ms: Number(row.created_at_ms),
    settled_at_ms: row.settled_at_ms === null ? null : Number(row.settled_at_ms),
    explorer_url: row.digest === null ? null : explorerTransactionUrl(explorer, row.digest),
  };
}

/** Up to `limit` of the account's logged transactions after `cursor`, newest first, with the next page's cursor. */
export async function readTransactionsPage(
  database: ReadableDatabase,
  accountId: string,
  query: TransactionsQuery,
): Promise<SocialTransactionsPage> {
  const { limit, cursor } = query;
  const { rows } = cursor === null
    ? await database.read<PageRow>(TRANSACTIONS_FIRST_PAGE_SQL, [accountId, limit + 1])
    : await database.read<PageRow>(TRANSACTIONS_NEXT_PAGE_SQL, [accountId, cursor.createdAtMs, cursor.txId, limit + 1]);
  const explorer = rows[0] && isSocialExplorer(rows[0].explorer) ? rows[0].explorer : DEFAULT_SOCIAL_EXPLORER;
  const logged = rows.filter((row): row is PageRow & LoggedRow => row.tx_id !== null);
  const page = logged.slice(0, limit);
  const last = page.at(-1);
  return {
    transactions: page.map((row) => transactionBody(row, explorer)),
    next_cursor: logged.length > limit && last ? encodeTransactionsCursor({ createdAtMs: last.created_at_ms, txId: last.tx_id }) : null,
    explorer,
  };
}
