import { likeLiteral } from "@blast/server/modules/social/search/like-literal.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialPresalePerson } from "@blast/core/modules/social/contracts/presales.ts";
import {
  SEARCH_PEOPLE_LIMIT,
  SEARCH_PRESALE_LIMIT,
  type SocialSearchPresale,
  type SocialSearchResponse,
} from "@blast/core/modules/social/contracts/search.ts";
import { readAsOf } from "@blast/server/modules/social/items/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { PUBLIC_PRESALES, liveSaleSql, presalePhase, upcomingSaleSql } from "@blast/core/modules/social/read-model/chain-presales.ts";

/**
 * Search's reads (canonical UI §12), on the replica: presales from
 * blast-infra's `chain_read_v1.presales` (a few hundred sales; a scan of the
 * view is a fraction of a millisecond, and the web cannot index blast-infra's
 * table), people from `social_account_search` (0072), whose two branches each
 * match through a trigram index on their haystack. Every person matched is
 * re-checked against the row's current callsign and name, so a member's
 * Mission Control name that its Blast name replaced never matches.
 */

export { likeLiteral } from "@blast/server/modules/social/search/like-literal.ts";

/** Live first, then upcoming (a scheduled start still ahead included), then the rest (`$now` is the time placeholder). */
const PHASE_RANK = (now: string) =>
  `CASE WHEN ${liveSaleSql("p", now)} THEN 0 WHEN ${upcomingSaleSql("p", now)} THEN 1 ELSE 2 END`;

const PRESALE_COLUMNS = `p.presale_id, p.sale_token AS coin_type, coalesce(p.sale_name, '') AS name, coalesce(p.sale_symbol, '') AS symbol, coalesce(p.sale_icon_url, '') AS icon_url,
  p.lifecycle, p.start_ms::text AS start_ms, p.end_ms::text AS end_ms, coalesce(trust.verified_team, false) AS verified_team`;

/** R3-23: one primary-key probe per sale; a sale with no row is not verified. */
const TRUST_JOIN = `LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id`;

/**
 * Name or symbol contains the term; exact, then verified by Blast (so the
 * real coin beats a copy with the same name or ticker), then prefix, then
 * live, upcoming, ended, then by name.
 */
const PRESALES_SQL = `
  SELECT ${PRESALE_COLUMNS}
  FROM ${PUBLIC_PRESALES} p
  ${TRUST_JOIN}
  WHERE lower(p.sale_name) LIKE $1 OR lower(p.sale_symbol) LIKE $1
  ORDER BY (lower(p.sale_name) = $2 OR lower(p.sale_symbol) = $2) DESC,
    coalesce(trust.verified_team, false) DESC,
    (lower(p.sale_name) LIKE $3 OR lower(p.sale_symbol) LIKE $3) DESC,
    ${PHASE_RANK("$4::bigint")}, lower(p.sale_name), p.presale_id
  LIMIT ${SEARCH_PRESALE_LIMIT}`;

/** Suggestions: live by closing time, then upcoming by opening time, then the latest to end. */
const SUGGESTED_PRESALES_SQL = `
  SELECT ${PRESALE_COLUMNS}
  FROM ${PUBLIC_PRESALES} p
  ${TRUST_JOIN}
  ORDER BY ${PHASE_RANK("$1::bigint")},
    CASE WHEN ${liveSaleSql("p", "$1::bigint")} THEN p.end_ms
      WHEN ${upcomingSaleSql("p", "$1::bigint")} THEN p.start_ms ELSE -p.end_ms END,
    p.presale_id
  LIMIT ${SEARCH_PRESALE_LIMIT}`;

/**
 * Callsign or name contains the term (`$1`), through the haystack index, then
 * re-checked on the current values; one row per callsign (a member whose
 * Blast name matches can come from both branches). Ranked: the exact
 * callsign (`$2`), a callsign prefix (`$3`), a name or name-word prefix
 * (`$3`, `$4`), then the shortest callsign.
 */
const PEOPLE_SQL = `
  SELECT m.callsign, m.display_name, m.avatar_url, m.verified
  FROM (
    SELECT DISTINCT ON (s.callsign) s.callsign, s.display_name, s.avatar_url, s.verified
    FROM social_account_search s
    WHERE s.haystack LIKE $1
      AND (lower(s.callsign) LIKE $1 OR lower(COALESCE(s.display_name, '')) LIKE $1)
    ORDER BY s.callsign
  ) m
  ORDER BY (m.callsign = $2) DESC, (m.callsign LIKE $3) DESC,
    (lower(COALESCE(m.display_name, '')) LIKE $3 OR lower(COALESCE(m.display_name, '')) LIKE $4) DESC,
    length(m.callsign), m.callsign
  LIMIT ${SEARCH_PEOPLE_LIMIT}`;

/**
 * A term of one or two characters matches people only at the start of their
 * callsign or of a word of their name ("lu": Luca Romano, @lucaromano):
 * "contains" would match most accounts, rank
 * nothing useful and cost a pass over all of them (no trigram is that
 * short). `$1` the term, `$2` 'lu%', `$3` '% lu%'.
 */
const PEOPLE_PREFIX_SQL = `
  SELECT m.callsign, m.display_name, m.avatar_url, m.verified
  FROM (
    SELECT DISTINCT ON (s.callsign) s.callsign, s.display_name, s.avatar_url, s.verified
    FROM social_account_search s
    WHERE (s.haystack LIKE $2 OR s.haystack LIKE $3)
      AND (lower(s.callsign) LIKE $2 OR lower(COALESCE(s.display_name, '')) LIKE $2 OR lower(COALESCE(s.display_name, '')) LIKE $3)
    ORDER BY s.callsign
  ) m
  ORDER BY (m.callsign = $1) DESC, (m.callsign LIKE $2) DESC, length(m.callsign), m.callsign
  LIMIT ${SEARCH_PEOPLE_LIMIT}`;

/** Below this many characters a person's term matches word starts only (`PEOPLE_PREFIX_SQL`). */
export const PEOPLE_CONTAINS_MIN = 3;

/** Suggestions: the operator's default accounts (the follows a new member starts with), public ones, in order. */
const SUGGESTED_PEOPLE_SQL = `
  SELECT i.callsign, i.display_name, i.avatar_url, i.verified
  FROM social_default_accounts d
  JOIN social_accounts a ON a.account_id = d.account_id AND a.privacy = 'public'
  JOIN social_account_identities i ON i.account_id = d.account_id
  ORDER BY d.position
  LIMIT ${SEARCH_PEOPLE_LIMIT}`;

type PresaleRow = Readonly<{ presale_id: string; coin_type?: string; name: string; symbol: string; icon_url: string; lifecycle: string; start_ms: string; end_ms: string; verified_team?: boolean }>;
type PersonRow = Readonly<{ callsign: string; display_name: string | null; avatar_url: string | null; verified: boolean | null }>;

function presaleOf(row: PresaleRow, nowMs: number): SocialSearchPresale {
  return {
    presale_id: row.presale_id,
    coin_type: row.coin_type,
    name: row.name,
    symbol: row.symbol,
    icon_url: row.icon_url,
    phase: presalePhase(row.lifecycle, Number(row.start_ms), Number(row.end_ms), nowMs),
    ...(row.verified_team === true ? { verified_team: true } : {}),
  };
}

function personOf(row: PersonRow): SocialPresalePerson {
  return { callsign: row.callsign, display_name: row.display_name, avatar_url: row.avatar_url, verified: row.verified === true };
}

/**
 * The answer for a normalized `term` (`normalizeSearchQuery`; "" for
 * suggestions) at `nowMs`. No readable watermark is `service_unavailable`.
 */
export async function readSearch(database: ReadableDatabase, term: string, nowMs: number): Promise<SocialSearchResponse> {
  const db = chainViewsOnly(database);
  const asOf = await readAsOf(db);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const like = likeLiteral(term);
  const [presales, people] = term
    ? await Promise.all([
      db.read<PresaleRow>(PRESALES_SQL, [`%${like}%`, term, `${like}%`, nowMs]),
      [...term].length < PEOPLE_CONTAINS_MIN
        ? db.read<PersonRow>(PEOPLE_PREFIX_SQL, [term, `${like}%`, `% ${like}%`])
        : db.read<PersonRow>(PEOPLE_SQL, [`%${like}%`, term, `${like}%`, `% ${like}%`]),
    ])
    : await Promise.all([db.read<PresaleRow>(SUGGESTED_PRESALES_SQL, [nowMs]), db.read<PersonRow>(SUGGESTED_PEOPLE_SQL)]);
  return {
    query: term,
    presales: presales.rows.map((row) => presaleOf(row, nowMs)),
    people: people.rows.map(personOf),
    as_of: asOf,
  };
}

/** The statements, for the scale bench (EXPLAIN ANALYZE) and tests. */
export const SEARCH_SQL = Object.freeze({
  presales: PRESALES_SQL,
  suggestedPresales: SUGGESTED_PRESALES_SQL,
  people: PEOPLE_SQL,
  peoplePrefix: PEOPLE_PREFIX_SQL,
  suggestedPeople: SUGGESTED_PEOPLE_SQL,
});
