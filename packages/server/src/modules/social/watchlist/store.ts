import { lockSocialAccount } from "../accounts/lookup.ts";
import type {
  ModuleTransaction,
  ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import {
  SOCIAL_WATCHLIST_LIMIT,
  type SocialWatchlistIds,
  type SocialWatchlistKeys,
  type SocialWatchlistPage,
} from "@blast/core/modules/social/contracts/watchlist.ts";
import { readAsOf } from "../items/index.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { readSummaries, summaryOf } from "../presales/summary.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { presaleExists } from "@blast/server/modules/social/read-model/presale-lookup.ts";
import { indexedPoolCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
type Social = ModuleTransaction<"social">;
/**
 * A page cursor: the row's time in microseconds (exact, unlike a JS date),
 * its presale id, and whether it is a followed presale (`include=follows`
 * reads list every star, then the followed presales not starred).
 */
export type WatchlistCursor = Readonly<{
  atUs: string;
  presaleId: string;
  followed: boolean;
}>;

export type WatchlistQuery = Readonly<{
  limit: number;
  cursor: WatchlistCursor | null;
  includeFollows: boolean;
}>;

export function encodeWatchlistCursor(cursor: WatchlistCursor): string {
  const parts = cursor.followed
    ? [cursor.atUs, cursor.presaleId, "f"]
    : [cursor.atUs, cursor.presaleId];
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

/**
 * One page of the watchlist and its total, in one statement. Stars newest
 * first (`social_watchlist_page_idx`, keyset in the index condition), each
 * with whether the presale is followed (the account's presale follows,
 * hashed once). With `$2` (include follows), then the account's followed
 * presales not starred, newest follow first: the follows primary-key prefix
 * (follower, 'presale') anti-joined to the account's stars and top-N sorted
 * in memory (at most `SOCIAL_FOLLOW_LIMIT` rows). `$3` is the cursor's part (null: none, 0: a
 * star, 1: a followed presale); a star's cursor starts the follows from the
 * top. Each branch stops at the limit before the two are joined. The total
 * row is there on an empty page too. A saved curve coin (its key a coin type,
 * which holds `::`) is not on the page: the page lists sales; Home reads curve
 * coins by `readWatchlistKeys`.
 */
export const WATCHLIST_ENTRIES_SQL = `
  SELECT t.total, u.presale_id, (extract(epoch FROM u.created_at) * 1000000)::bigint::text AS at_us, u.starred, u.followed
  FROM (
    SELECT (SELECT count(*) FROM social_watchlist WHERE account_id = $1::uuid AND presale_id NOT LIKE '%::%')::int
      + CASE WHEN $2::boolean THEN (
          SELECT count(*) FROM social_follows f
          WHERE f.follower_account_id = $1::uuid AND f.target_kind = 'presale'
            AND NOT EXISTS (SELECT 1 FROM social_watchlist w WHERE w.account_id = $1::uuid AND w.presale_id = f.target_id)
        )::int ELSE 0 END AS total
  ) t
  LEFT JOIN LATERAL (
    (SELECT 0 AS part, w.presale_id, w.created_at, true AS starred,
       EXISTS (
         SELECT 1 FROM social_follows f
         WHERE f.follower_account_id = $1::uuid AND f.target_kind = 'presale' AND f.target_id = w.presale_id
       ) AS followed
     FROM social_watchlist w
     WHERE w.account_id = $1::uuid AND w.presale_id NOT LIKE '%::%'
       AND ($3::int IS NULL OR ($3::int = 0 AND (w.created_at, w.presale_id) < ('epoch'::timestamptz + $4::bigint * interval '1 microsecond', $5::text)))
     ORDER BY w.created_at DESC, w.presale_id DESC
     LIMIT $6)
    UNION ALL
    (SELECT 1, f.target_id, f.created_at, false, true
     FROM social_follows f
     WHERE $2::boolean AND f.follower_account_id = $1::uuid AND f.target_kind = 'presale'
       AND ($3::int IS DISTINCT FROM 1 OR (f.created_at, f.target_id) < ('epoch'::timestamptz + $4::bigint * interval '1 microsecond', $5::text))
       AND NOT EXISTS (SELECT 1 FROM social_watchlist w WHERE w.account_id = $1::uuid AND w.presale_id = f.target_id)
     ORDER BY f.created_at DESC, f.target_id DESC
     LIMIT $6)
  ) AS u ON TRUE
  ORDER BY u.part, u.created_at DESC, u.presale_id DESC
  LIMIT $6`;

export type WatchlistEntry = Readonly<{
  presale_id: string;
  at_us: string;
  starred: boolean;
  followed: boolean;
}>;

/**
 * Up to `limit` watchlist entries after `cursor` (stars, then with
 * `includeFollows` the followed presales not starred) and the total, as one
 * statement.
 */
export async function readWatchlistEntries(
  database: ReadableDatabase,
  accountId: string,
  query: Readonly<{
    limit: number;
    cursor: WatchlistCursor | null;
    includeFollows: boolean;
  }>,
): Promise<Readonly<{ entries: WatchlistEntry[]; total: number }>> {
  const { rows } = await database.read<{
    total: number;
    presale_id: string | null;
    at_us: string;
    starred: boolean;
    followed: boolean;
  }>(WATCHLIST_ENTRIES_SQL, [
    accountId,
    query.includeFollows,
    query.cursor === null ? null : query.cursor.followed ? 1 : 0,
    query.cursor?.atUs ?? null,
    query.cursor?.presaleId ?? null,
    query.limit,
  ]);
  return {
    entries: rows.flatMap((row) =>
      row.presale_id === null
        ? []
        : [
            {
              presale_id: row.presale_id,
              at_us: row.at_us,
              starred: row.starred,
              followed: row.followed,
            },
          ],
    ),
    total: rows[0]?.total ?? 0,
  };
}

/** Every saved key, sales and curve coins, newest first. */
const KEYS_SQL = `
  SELECT presale_id FROM social_watchlist WHERE account_id = $1::uuid
  ORDER BY created_at DESC, presale_id DESC
  LIMIT ${SOCIAL_WATCHLIST_LIMIT}`;

/** One page of the watchlist's sales with each presale's list summary, exactly as the route answers it. */
export async function readWatchlistPage(
  database: ReadableDatabase,
  accountId: string,
  query: WatchlistQuery,
  nowMs: number,
): Promise<SocialWatchlistPage> {
  const db = chainViewsOnly(database);
  const [asOf, read] = await Promise.all([
    readAsOf(db),
    readWatchlistEntries(db, accountId, { ...query, limit: query.limit + 1 }),
  ]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const rows = read.entries.slice(0, query.limit);
  const summaries = new Map(
    (
      await readSummaries(
        db,
        rows.map((row) => row.presale_id),
      )
    ).map((row) => [row.presale_id, row]),
  );
  const last = rows[rows.length - 1];
  return {
    items: rows.flatMap((row) => {
      const summary = summaries.get(row.presale_id);
      return summary
        ? [
            {
              presale: summaryOf(summary, nowMs),
              added_ms: Math.floor(Number(row.at_us) / 1_000),
              starred: row.starred,
              followed: row.followed,
            },
          ]
        : [];
    }),
    total: read.total,
    next_cursor:
      read.entries.length > query.limit && last
        ? encodeWatchlistCursor({
            atUs: last.at_us,
            presaleId: last.presale_id,
            followed: !last.starred,
          })
        : null,
    as_of: asOf,
  };
}

/** Every saved key (presale ids and curve coin types), newest first. */
export async function readWatchlistKeys(
  database: ReadableDatabase,
  accountId: string,
): Promise<SocialWatchlistKeys> {
  const { rows } = await database.read<{ presale_id: string }>(KEYS_SQL, [accountId]);
  return { keys: rows.map((row) => row.presale_id) };
}

/** Every saved presale id, newest first; saved curve coins are left out. */
export async function readWatchlistIds(
  database: ReadableDatabase,
  accountId: string,
): Promise<SocialWatchlistIds> {
  const { keys } = await readWatchlistKeys(database, accountId);
  return { presale_ids: keys.filter((key) => !isCoinKey(key)) };
}

/** A standalone coin's key is its coin type; a sale's is its presale id. */
function isCoinKey(key: string): boolean {
  return key.includes("::");
}

/** Presales own their watchlist key, including when the presale is hidden. */
const STANDALONE_COIN_EXISTS_SQL = `
  SELECT 1
  WHERE NOT EXISTS (SELECT 1 FROM chain_read_v1.presales p WHERE p.sale_token = $1)
    AND ($2::boolean OR EXISTS (
      SELECT 1 FROM chain_read_v1.vaults v WHERE v.meme_type = $1 AND v.origin_kind = 'launch'
    ))`;

/** A curated pool coin with its own coin page; majors such as SUI are not starred. */
function isWatchablePoolCoin(key: string): boolean {
  const coin = indexedPoolCoin(key);
  return coin?.coinType === key && !coin.major;
}

async function savedCoinExists(social: Social, key: string): Promise<boolean> {
  if (!isCoinKey(key)) return presaleExists(social, key);
  const { rowCount } = await social.read(STANDALONE_COIN_EXISTS_SQL, [key, isWatchablePoolCoin(key)]);
  return rowCount !== null && rowCount > 0;
}

/**
 * Stars `presaleId` (a presale id, or a standalone coin's type) for `accountId`,
 * idempotently. The account row is locked first (`FOR NO KEY UPDATE`, as follows do), so concurrent stars by one
 * account count one at a time and the limit holds; a star already there is a
 * success at any count and keeps its time.
 */
export async function star(social: Social, accountId: string, presaleId: string): Promise<void> {
  if (!(await savedCoinExists(social, presaleId))) throw new SocialRouteError("not_found");
  await lockSocialAccount(social, accountId);
  const current = await social.read<{ total: number; present: boolean }>(
    `SELECT count(*)::int AS total, COALESCE(bool_or(presale_id = $2), false) AS present
     FROM social_watchlist WHERE account_id = $1`,
    [accountId, presaleId],
  );
  const { total, present } = current.rows[0]!;
  if (present) return;
  if (total >= SOCIAL_WATCHLIST_LIMIT) throw new SocialRouteError("watchlist_limit");
  await social.write(
    "social_watchlist",
    "INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [accountId, presaleId],
  );
}

export async function unstar(social: Social, accountId: string, presaleId: string): Promise<void> {
  await social.write(
    "social_watchlist",
    "DELETE FROM social_watchlist WHERE account_id = $1 AND presale_id = $2",
    [accountId, presaleId],
  );
}
