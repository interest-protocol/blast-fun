import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PRESALE_BACKER_SAMPLE,
  PRESALE_BACKER_SAMPLE_COMMITS,
  type SocialPresalePerson,
  type SocialPresaleSummary,
} from "@blast/core/modules/social/contracts/presales.ts";
import { PERSON_COLUMNS, personOf, type PersonColumns } from "@blast/core/modules/social/presales/sql.ts";
import { namedWalletsOfSql } from "@blast/core/modules/social/read-model/naming.ts";

/**
 * Redesign gap 11: a list summary's facepile. For each sale ($1), its latest
 * $2 commits walk the partial index `activity_presale_commit_window`
 * backwards (never the sale's whole history, and never every wallet sorted
 * by commitment). The page's distinct wallets are named once, as a set
 * (`namedWalletsOfSql`, materialized and hash-joined, as the feed's backers
 * read does). A wallet with a public, sharing owner is named when it made no
 * commit to the sale before its owner shared and linked it: the sale page's
 * rule (`namedPositionSql`: both no later than the wallet's first commit),
 * its two time conditions folded into one and asked as "no earlier commit",
 * one range of the `(actor, timestamp_ms)` index ending at that time (empty,
 * and so free, when sharing began before the wallet's commits; the bound is
 * `ceil(named_from_ms)` as a bigint, the same test for whole-millisecond
 * times, so it is an index condition and not a filter). An account
 * reached through two wallets is one face, at its latest commit; its
 * identity is read by its key.
 */
export const BACKER_SAMPLE_SQL = `SELECT b.presale_id, b.last_ms::text AS last_ms, ${PERSON_COLUMNS}
  FROM (
    WITH sample_recent AS MATERIALIZED (
      SELECT s.presale_id, c.actor, max(c.timestamp_ms) AS last_ms
      FROM unnest($1::text[]) AS s(presale_id)
      CROSS JOIN LATERAL (
        SELECT a.actor, a.timestamp_ms FROM chain_read_v1.activity a
        WHERE a.presale_id = s.presale_id AND a.kind = 'presale_commit'
        ORDER BY a.timestamp_ms DESC
        LIMIT $2::int
      ) c
      GROUP BY s.presale_id, c.actor
    ), sample_named AS MATERIALIZED (
      ${namedWalletsOfSql("ARRAY(SELECT DISTINCT r.actor FROM sample_recent r)")}
    )
    SELECT DISTINCT ON (r.presale_id, n.account_id) r.presale_id, n.account_id, r.last_ms
    FROM sample_recent r
    JOIN sample_named n ON n.address = r.actor
    WHERE NOT EXISTS (
      SELECT 1 FROM chain_read_v1.activity f
      WHERE f.actor = r.actor AND f.timestamp_ms < ceil(n.named_from_ms)::bigint
        AND f.presale_id = r.presale_id AND f.kind = 'presale_commit'
    )
    ORDER BY r.presale_id, n.account_id, r.last_ms DESC
  ) b
  JOIN LATERAL (
    SELECT ii.callsign, ii.display_name, ii.avatar_url, ii.x_handle FROM social_account_identities ii WHERE ii.account_id = b.account_id
    OFFSET 0
  ) i ON TRUE`;

type SampleRow = PersonColumns & Readonly<{ presale_id: string; last_ms: string }>;

/** Each sale's facepile, the latest backer first (a sale with no named backer among its latest commits is absent). */
export async function readBackerSamples(db: ReadableDatabase, presaleIds: readonly string[]): Promise<ReadonlyMap<string, readonly SocialPresalePerson[]>> {
  if (presaleIds.length === 0) return new Map();
  const { rows } = await db.read<SampleRow>(BACKER_SAMPLE_SQL, [[...new Set(presaleIds)], PRESALE_BACKER_SAMPLE_COMMITS]);
  const bySale = new Map<string, SampleRow[]>();
  for (const row of rows) bySale.set(row.presale_id, [...(bySale.get(row.presale_id) ?? []), row]);
  return new Map([...bySale].map(([presaleId, sample]) => [
    presaleId,
    sample
      .sort((a, b) => Number(b.last_ms) - Number(a.last_ms) || (a.person_callsign ?? "").localeCompare(b.person_callsign ?? ""))
      .flatMap((row) => personOf(row) ?? [])
      .slice(0, PRESALE_BACKER_SAMPLE),
  ]));
}

/** The summaries with their facepiles (`backers_sample`, empty when no latest backer is named). */
export async function withBackerSamples(db: ReadableDatabase, summaries: readonly SocialPresaleSummary[]): Promise<SocialPresaleSummary[]> {
  const samples = await readBackerSamples(db, summaries.map((summary) => summary.presale_id));
  return summaries.map((summary) => ({ ...summary, backers_sample: samples.get(summary.presale_id) ?? [] }));
}
