import { z } from "zod";
import { socialUuidSchema } from "@blast/core/modules/social/contracts/primitives.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { likeLiteral } from "@blast/server/modules/social/search/like-literal.ts";
import type { ConnectionAccount, ConnectionTab, SocialConnectionCounts, SocialConnections } from "@blast/core/modules/social/contracts/connections.ts";

type Position = readonly [createdAt: string, accountId: string];
type ConnectionQuery = Readonly<{ tab: ConnectionTab | null; q: string; limit: number; before: Position | null }>;

function invalid(parameter: string): never {
  throw new SocialRouteError("invalid_parameter", { extra: { parameter } });
}

/** Cursors carry their profile, tab and search so they cannot silently skip a different list. */
export function parseConnectionQuery(url: URL, callsign: string): ConnectionQuery {
  const query = url.searchParams;
  for (const name of ["tab", "q", "limit", "cursor"]) socialSingle(query, name);
  const tab = socialParameter(z.enum(["followers", "following"]).nullable(), query.get("tab"), "tab");
  const q = (query.get("q") ?? "").trim().replace(/^@/, "").toLowerCase();
  socialParameter(z.string().max(80).refine((value) => tab !== null || (!value && !query.has("cursor"))), q, "q");
  const rawLimit = query.get("limit");
  const limit = socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(50)).nullable().transform((value) => value ?? 20), rawLimit, "limit");
  const cursor = query.get("cursor");
  return { tab, q, limit, before: cursor === null ? null : decodeConnectionCursor(cursor, callsign, tab, q) };
}

function decodeConnectionCursor(cursor: string, callsign: string, tab: ConnectionTab | null, q: string): Position {
  if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid("cursor");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { invalid("cursor"); }
  const [,,, time, id] = socialParameter(z.tuple([
    z.literal(callsign), z.literal(tab), z.literal(q),
    z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine((time) =>
      !time.startsWith("0000-") && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === `${time.slice(0, 23)}Z`),
    socialUuidSchema,
  ]), decoded, "cursor");
  return [time, id];
}

type Row = ConnectionAccount & Readonly<{ created_at: string; account_id: string }>;

// A scalar callsign lookup preserves unique-index reads without propagating inflated union estimates.
const TARGET_SQL = `
  SELECT a.account_id, a.account_id = $2::uuid AS own
  FROM social_accounts a
  WHERE a.account_id = (SELECT account_id FROM social_account_callsigns WHERE callsign = $1)
    AND (a.privacy = 'public' OR a.account_id = $2::uuid)
`;

// Counts need privacy, not identities, search, ordering or page materialization.
const COUNTS_SQL = `SELECT c.followers, c.following
  FROM social_accounts t CROSS JOIN (
    SELECT count(*) FILTER (WHERE f.incoming AND a.privacy = 'public')::float8 AS followers,
      count(*) FILTER (WHERE NOT f.incoming)::float8 AS following
    FROM (
      SELECT follower_account_id AS account_id, true AS incoming FROM social_follows
        WHERE target_kind = 'account' AND target_id = $1::text
      UNION ALL
      SELECT target_id::uuid AS account_id, false AS incoming FROM social_follows
        WHERE target_kind = 'account' AND follower_account_id = $1::uuid
    ) f JOIN social_accounts a ON a.account_id = f.account_id
    WHERE a.privacy = 'public' OR $1::uuid = $2::uuid
  ) c WHERE t.account_id = $1::uuid AND (t.privacy = 'public' OR t.account_id = $2::uuid)`;

export async function readConnectionCounts(db: ReadableDatabase, callsign: string, viewerId: string | null): Promise<SocialConnectionCounts> {
  // Binding the resolved ID lets PostgreSQL use follower skew statistics for large profiles.
  const target = (await db.read<{ account_id: string }>(TARGET_SQL, [callsign, viewerId])).rows[0];
  if (!target) throw new SocialRouteError("not_found");
  // Recheck target privacy in the count statement: the lookup may have a different snapshot.
  const result = (await db.read<SocialConnectionCounts>(COUNTS_SQL, [target.account_id, viewerId])).rows[0];
  if (!result) throw new SocialRouteError("not_found");
  return result;
}

// Order and cursor use the follow's columns so both directions can walk their index.
function connectionPageSql(tab: ConnectionTab, before: Position | null, indexedSearch: boolean): string {
  const accountId = tab === "followers" ? "f.follower_account_id" : "f.target_id::uuid";
  const relationship = tab === "followers" ? "f.target_id = t.account_id::text" : "f.follower_account_id = t.account_id";
  const member = (id: string) => `${relationship} AND ${tab === "followers" ? `f.follower_account_id = ${id}` : `f.target_id = ${id}::text`}`;
  const privacy = tab === "followers" ? "a.privacy = 'public'" : "(t.own OR a.privacy = 'public')";
  const cursor = before ? `AND (f.created_at, ${accountId}) < ($4::timestamptz, $5::uuid)` : "AND $4::timestamptz IS NULL AND $5::uuid IS NULL";
  const accounts = (from: string) => `COALESCE((SELECT jsonb_agg(row) FROM (
    SELECT i.callsign, i.display_name, i.avatar_url, i.verified, a.privacy = 'private' AS private,
      ${accountId}::text AS account_id,
      to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM ${from}
    JOIN social_accounts a ON a.account_id = ${accountId}
    JOIN social_account_identities i ON i.account_id = a.account_id
    WHERE f.target_kind = 'account' AND ${relationship} AND ${privacy}
      AND (position($3 IN lower(i.callsign)) > 0 OR position($3 IN lower(COALESCE(i.display_name, ''))) > 0)
      ${cursor}
    ORDER BY f.created_at DESC, ${accountId} DESC LIMIT $6
  ) row), '[]'::jsonb)`;
  const ordered = accounts("social_follows f");
  if (!indexedSearch) return `SELECT ${ordered} AS accounts FROM (${TARGET_SQL}) t`;

  // Keep sparse candidates first: LATERAL LIMIT preserves point relationship lookups.
  const sparse = accounts(`(SELECT DISTINCT account_id FROM matches) c CROSS JOIN LATERAL (
    SELECT f.* FROM social_follows f WHERE f.target_kind = 'account' AND ${member("c.account_id")} LIMIT 1
  ) f`);
  // shortcut: broad global matches use the page index; revisit if sparse list matches are slow.
  return `SELECT result.accounts FROM (WITH target AS MATERIALIZED (${TARGET_SQL}), matches AS MATERIALIZED (
    SELECT a.account_id FROM social_accounts a CROSS JOIN target t
    WHERE lower(COALESCE(a.callsign, '') || ' ' || COALESCE(a.display_name, '')) LIKE $7 AND ${privacy}
      AND (position($3 IN lower(a.callsign)) > 0 OR position($3 IN lower(COALESCE(a.display_name, ''))) > 0)
    UNION ALL
    SELECT a.account_id FROM mission_control_profiles p
    JOIN LATERAL (SELECT account_id, privacy, display_name FROM social_accounts WHERE profile_id = p.profile_id LIMIT 1) a ON TRUE
    CROSS JOIN target t
    WHERE lower(p.callsign || ' ' || COALESCE(p.display_name, '')) LIKE $7 AND ${privacy}
      AND (position($3 IN lower(p.callsign)) > 0 OR position($3 IN lower(COALESCE(a.display_name, p.display_name, ''))) > 0)
    LIMIT 257
  ) SELECT CASE WHEN EXISTS (SELECT 1 FROM matches OFFSET 256)
    THEN ${ordered} ELSE ${sparse} END AS accounts FROM target t) result`;
}

export async function readConnections(db: ReadableDatabase, callsign: string, viewerId: string | null, query: ConnectionQuery & { tab: ConnectionTab }): Promise<SocialConnections> {
  const { tab, q, limit, before } = query;
  // Short substrings keep their exact behavior; pg_trgm needs usable trigrams.
  const indexedSearch = q.length >= 3;
  const sql = connectionPageSql(tab, before, indexedSearch);
  const values: unknown[] = [callsign, viewerId, q, before?.[0] ?? null, before?.[1] ?? null, limit + 1];
  if (indexedSearch) values.push(`%${likeLiteral(q)}%`);
  const result = (await db.read<{ accounts: Row[] }>(sql, values)).rows[0];
  if (!result) throw new SocialRouteError("not_found");
  const accounts = result.accounts.slice(0, limit);
  const last = accounts.at(-1);
  const next_cursor = result.accounts.length > limit && last
    ? Buffer.from(JSON.stringify([callsign, tab, q, last.created_at, last.account_id])).toString("base64url") : null;
  return { accounts: accounts.map(({ callsign, display_name, avatar_url, verified, private: isPrivate }) => ({ callsign, display_name, avatar_url, verified, private: isPrivate })), next_cursor };
}
