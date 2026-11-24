import type { LaunchIdentity } from "@blast/core/modules/launchpad-social/launch-identity.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";
import { z } from "zod";
import { createHash } from "node:crypto";

import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import {
  CursorError,
  decodeCursor,
  encodeCursor,
  pageLimit,
  type CursorPosition,
  type CursorShape,
} from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { isDatabaseUnavailableError } from "@blast/core/modules/database/availability.ts";
import {
  autocommitReader,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import {
  readChainJoin,
  type ChainJoinDependencies,
} from "@blast/server/modules/read-routing/chain-join.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import type { ReplicaResource } from "@blast/core/modules/read-routing/resources.ts";
import {
  searchQuery,
  thesesCursor,
} from "@blast/server/modules/launchpad-social/contracts.ts";
import type { Visibility } from "@blast/core/modules/launchpad-social/post-contract.ts";
import {
  SOCIAL_LIMITS,
  type SocialLimits,
} from "@blast/core/modules/launchpad-social/limits.ts";
import {
  IS_CURRENT,
  LAUNCH_IDENTITY_COLUMNS,
  POST_COLUMNS,
  launchIdentityFromRow,
  postFromRow,
  type AuditRecord,
  type PostRecord,
} from "@blast/server/modules/launchpad-social/repository.ts";

export type {
  AuditRecord,
  PostRecord,
} from "@blast/server/modules/launchpad-social/repository.ts";

/**
 * A post as the public sees it (spec §6.9's `SocialPost` plus its thesis,
 * revision, first-post time and provenance): only public records are shown,
 * and the author is the opaque `authorIdentityId`. A wallet appears only as
 * the author's disclosed `disclosure.walletAddress`.
 */
export function publicPost(record: PostRecord): PublicPost {
  return {
    id: record.id,
    thesisId: record.thesisId,
    revisionOf: record.revisionOf,
    launchId: record.launchId,
    kind: record.kind,
    stance: record.stance,
    authorIdentityId: record.authorIdentityId,
    body: record.body,
    evidenceLinks: record.evidenceLinks,
    disclosure: record.disclosure,
    authorLabels: record.authorLabels,
    moderationState: "public",
    provenance: record.provenance,
    postedAt: record.postedAt,
    createdAt: record.createdAt,
  };
}

export type ModerationAction = Readonly<{
  actionId: string;
  recordId: string;
  visibility: Visibility;
  reason: string;
  moderator: string;
  actedAt: string;
}>;

export type PostAudit = Readonly<{
  /** Every record of the post, oldest first, hidden ones included, with the author's identity. */
  records: readonly AuditRecord[];
  /** Every visibility change of those records, oldest first. */
  moderation: readonly ModerationAction[];
}>;

/**
 * The durable audit identity of a post: every version with its author's
 * identity and every moderation action, whatever is public now. For
 * moderators and operators on the primary, never a public response. Null when
 * there is no such post.
 */
export async function postAudit(
  database: ReadableDatabase,
  thesisId: string,
): Promise<PostAudit | null> {
  const records = await database.read(
    `SELECT ${POST_COLUMNS}, a.author_method, a.author_subject_key, a.author_wallet
     FROM mission_control_launchpad_theses t
     JOIN mission_control_launchpad_social_authors a ON a.author_identity_id = t.author_identity_id
     WHERE t.thesis_id = $1
     ORDER BY t.created_at, t.record_id`,
    [thesisId],
  );
  if (records.rowCount === 0) return null;
  const moderation = await database.read<{
    action_id: string;
    record_id: string;
    visibility: Visibility;
    reason: string;
    moderator: string;
    acted_at: Date;
  }>(
    `SELECT m.action_id, m.record_id, m.visibility, m.reason, m.moderator, m.acted_at
     FROM mission_control_launchpad_thesis_moderation m
     JOIN mission_control_launchpad_theses t ON t.record_id = m.record_id
     WHERE t.thesis_id = $1
     ORDER BY m.acted_at, m.action_id`,
    [thesisId],
  );
  return {
    records: records.rows.map((row) => ({
      ...postFromRow(row),
      author: {
        method: row.author_method,
        subjectKey: row.author_subject_key,
        walletAddress: row.author_wallet,
      },
    })),
    moderation: moderation.rows.map((row) => ({
      actionId: row.action_id,
      recordId: row.record_id,
      visibility: row.visibility,
      reason: row.reason,
      moderator: row.moderator,
      actedAt: row.acted_at.toISOString(),
    })),
  };
}

/** The primary could not serve a hybrid read's social records; not a replica outage. */
class SocialRecordsUnavailable extends Error {
  constructor() {
    super("Social records are unavailable.");
    this.name = "SocialRecordsUnavailable";
  }
}

/**
 * Where public thesis reads find posts, moderation and search rows: the
 * primary (`WORKLOAD_ROUTES.social`), so a hidden or revised record leaves
 * every public read at once, however far the replica lags. Injected chain-join
 * dependencies name the primary as `primary`. An outage of it is a
 * SocialRecordsUnavailable, which the chain join does not mistake for its own.
 */
function socialRecords(
  dependencies: ChainJoinDependencies | undefined,
): ReadableDatabase {
  const database =
    dependencies?.primary ??
    autocommitReader(databaseFor("social"), "launchpad-social", {
      label: "launchpad.theses",
    });
  return {
    async read(text, values) {
      try {
        return await database.read(text, values);
      } catch (error) {
        if (isDatabaseUnavailableError(error))
          throw new SocialRecordsUnavailable();
        throw error;
      }
    },
  };
}

/**
 * A hybrid thesis read: `query` reads chain identity through the chain views
 * on the resource's database (the replica, as `readChainJoin` routes it) and
 * social records from the primary. Unavailable when either is.
 */
async function hybridRead<T>(
  resource: ReplicaResource,
  dependencies: ChainJoinDependencies | undefined,
  query: (views: ReadableDatabase, social: ReadableDatabase) => Promise<T>,
): Promise<RoutedRead<T>> {
  const social = socialRecords(dependencies);
  const observedAt = (dependencies?.now ?? Date.now)();
  try {
    return await readChainJoin(
      resource,
      (views) => query(views, social),
      dependencies,
    );
  } catch (error) {
    if (!(error instanceof SocialRecordsUnavailable)) throw error;
    recordMetric("read.degraded", {
      resource,
      outcome: "unavailable",
      reason: "social-unavailable",
    });
    return {
      status: "unavailable",
      provenance: {
        source: "primary",
        network: null,
        deployment: null,
        checkpoint: null,
        timestampMs: null,
        observedAt,
        lagMs: null,
        reason: "social-unavailable",
      },
    };
  }
}

const CURVE_POOL = "blast_curve:";

/**
 * The canonical launches among `launchIds`, with their identity, read
 * through the chain views: a launch whose curve `chain_read_v1.pools` lists
 * with its coin in `chain_read_v1.coins`.
 */
async function canonicalLaunches(
  views: ReadableDatabase,
  launchIds: readonly string[],
): Promise<Map<string, LaunchIdentity>> {
  if (launchIds.length === 0) return new Map();
  const result = await views.read(
    `SELECT p.pool_key, ${LAUNCH_IDENTITY_COLUMNS}
     FROM chain_read_v1.pools p
     JOIN chain_read_v1.coins c ON c.coin_type = p.coin_type
     WHERE p.venue = 'blast_curve' AND p.pool_key = ANY($1::text[])`,
    [launchIds.map((launchId) => `${CURVE_POOL}${launchId}`)],
  );
  return new Map(
    result.rows.map((row) => {
      const launchId = (row.pool_key as string).slice(CURVE_POOL.length);
      return [launchId, launchIdentityFromRow({ ...row, launch_id: launchId })];
    }),
  );
}

export type ThesisPage = Readonly<{
  launchId: string;
  theses: readonly PublicPost[];
  /** The token for the next page, or null on the last one. */
  nextCursor: string | null;
}>;

export type PageRequest = Readonly<{
  limit?: string | null;
  cursor?: string | null;
}>;

const BIGINT_MAX = 9_223_372_036_854_775_807n;
const RECORD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A decoded list or search token's position, or a CursorError: a key within
 * PostgreSQL's `bigint` and a thesis ID tie-break. Tokens are unsigned, so
 * this runs before any read and a forged one is a 400, never a database error.
 */
function thesisPosition(position: CursorPosition): CursorPosition {
  if (BigInt(position.key[0]) > BIGINT_MAX) throw new CursorError("the cursor's time is out of range");
  if (!z.string().regex(RECORD_ID).safeParse(position.tie[0]).success) throw new CursorError("the cursor's tie-break is not a thesis ID");
  return position;
}

/**
 * One page of a launch's public posts: each post's current record, newest
 * first post first (a revision keeps its post's place), then thesis ID. The
 * cursor is bound to the launch and resumes strictly after its place, so new
 * posts, revisions and hidden posts never repeat or skip another post.
 * Hidden records, superseded records and a launch absent from the canonical
 * launch views give nothing. A hybrid read: the launch's canonical identity
 * through the chain views (`thesis-join`: the replica, the primary when the
 * replica lags, with provenance) and its posts from the primary, so a hidden
 * record is gone at once. A bad launch ID, a token of another list, or one
 * whose key is past `bigint` or whose tie-break is not a thesis ID is a
 * CursorError before any read; limits clamp to the configured page
 * (`limits.thesisPage`).
 */
export async function listLaunchTheses(
  launchId: string,
  request: PageRequest,
  dependencies?: ChainJoinDependencies,
  limits: SocialLimits = SOCIAL_LIMITS,
): Promise<RoutedRead<ThesisPage>> {
  if (!parseLaunchId(launchId))
    throw new CursorError("launch_id must be a canonical object id");
  const limit = pageLimit(request.limit ?? null, limits.thesisPage);
  const shape = thesesCursor(launchId);
  const after =
    request.cursor === undefined || request.cursor === null
      ? null
      : thesisPosition(decodeCursor(request.cursor, shape));
  return hybridRead("thesis-join", dependencies, async (views, social) => {
    if (!(await canonicalLaunches(views, [launchId])).has(launchId))
      return { launchId, theses: [], nextCursor: null };
    const result = await social.read(
      `SELECT ${POST_COLUMNS},
         (extract(epoch FROM t.thesis_created_at) * 1000000)::bigint::text AS posted_us
       FROM mission_control_launchpad_theses t
       WHERE t.launch_id = $1 AND t.visibility = 'public' AND ${IS_CURRENT}
         AND ($2::bigint IS NULL
           OR ((extract(epoch FROM t.thesis_created_at) * 1000000)::bigint, t.thesis_id) < ($2::bigint, $3::uuid))
       ORDER BY t.thesis_created_at DESC, t.thesis_id DESC
       LIMIT $4`,
      [launchId, after?.key[0] ?? null, after?.tie[0] ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      launchId,
      theses: rows.map((row) => publicPost(postFromRow(row))),
      nextCursor:
        result.rows.length > limit && last
          ? encodeCursor(
              shape,
              [last.posted_us as string],
              [last.thesis_id as string],
            )
          : null,
    };
  });
}

export type SearchHit = Readonly<{
  thesis: PublicPost;
  launch: LaunchIdentity;
}>;

export type SearchPage = Readonly<{
  theses: readonly SearchHit[];
  /** The token for the next page, or null on the last one. */
  nextCursor: string | null;
}>;

/**
 * A thesis search's page token: bound to the query (a hash of its tsquery,
 * so the token stays short), keyed by the post's first-post time in
 * microseconds, tie-break the thesis ID.
 */
export function thesisSearchCursorShape(
  query: string,
  limits: SocialLimits = SOCIAL_LIMITS,
): CursorShape {
  const fingerprint = createHash("sha256")
    .update(searchQuery(query, limits))
    .digest("hex")
    .slice(0, 16);
  return { scope: `search_theses:${fingerprint}`, key: ["decimal"], tie: 1 };
}

/**
 * How many batches of `limit + 1` matching posts one search page reads from
 * the primary before it answers with what it found: posts of launches the
 * chain views do not list (a replay) are skipped, so a page may be short, and
 * its token then resumes after the last post read. A page that has no hit yet
 * reads on up to `SEARCH_FIRST_HIT_BATCHES`, so a match behind a run of
 * skipped posts still shows on the first page. Bounds on work per request,
 * not product limits: a page past them may hold no hit and still a token.
 */
const SEARCH_BATCHES = 4;
const SEARCH_FIRST_HIT_BATCHES = 16;

/**
 * Searches the materialized post text: every word as a prefix, newest first
 * post first, then thesis ID, as a launch's own list orders its posts (a
 * revision keeps its post's place and its shown first-post time). Equal text
 * and equal times always come back in the same order and a page token
 * resumes strictly after its place (no score: every hit matches every word).
 * A hybrid read: the public, current records and their search rows from the
 * primary, so a hidden or revised record stops matching at once, each joined
 * to its launch's identity in the chain views (`search`: the replica, stale
 * or unavailable as its policy says) — coin metadata, the curve's lifecycle
 * and creation time, the creator. A post whose launch is not canonical gives
 * nothing, and no market fact is read. A page reads at most `SEARCH_BATCHES`
 * batches (`SEARCH_FIRST_HIT_BATCHES` while it has no hit), so one with
 * skipped posts may hold fewer than `limit` hits, even none, and still a
 * token. A query without words is a SocialQueryError, and a token of
 * another query a CursorError, before any read; limits clamp to
 * `limits.searchPage`.
 */
export async function searchTheses(
  query: string,
  request: PageRequest,
  dependencies?: ChainJoinDependencies,
  limits: SocialLimits = SOCIAL_LIMITS,
): Promise<RoutedRead<SearchPage>> {
  const tsquery = searchQuery(query, limits);
  const limit = pageLimit(request.limit ?? null, limits.searchPage);
  const shape = thesisSearchCursorShape(query, limits);
  const after =
    request.cursor === undefined || request.cursor === null
      ? null
      : thesisPosition(decodeCursor(request.cursor, shape));
  return hybridRead("search", dependencies, async (views, social) => {
    const hits: { hit: SearchHit; position: [string, string] }[] = [];
    let position: [string, string] | null = after
      ? [String(after.key[0]), after.tie[0]]
      : null;
    let exhausted = false;
    for (
      let batch = 0;
      (batch < SEARCH_BATCHES ||
        (hits.length === 0 && batch < SEARCH_FIRST_HIT_BATCHES)) &&
      hits.length <= limit &&
      !exhausted;
      batch += 1
    ) {
      const result = await social.read(
        `SELECT ${POST_COLUMNS},
           (extract(epoch FROM t.thesis_created_at) * 1000000)::bigint::text AS posted_us
         FROM mission_control_launchpad_search_documents d
         JOIN mission_control_launchpad_theses t ON t.record_id = d.record_id
         WHERE d.search_vector @@ to_tsquery('simple', $1) AND t.visibility = 'public' AND ${IS_CURRENT}
           AND ($2::bigint IS NULL
             OR ((extract(epoch FROM t.thesis_created_at) * 1000000)::bigint, t.thesis_id) < ($2::bigint, $3::uuid))
         ORDER BY t.thesis_created_at DESC, t.thesis_id DESC
         LIMIT $4`,
        [tsquery, position?.[0] ?? null, position?.[1] ?? null, limit + 1],
      );
      exhausted = result.rows.length <= limit;
      const launches = await canonicalLaunches(views, [
        ...new Set(result.rows.map((row) => row.launch_id as string)),
      ]);
      for (const row of result.rows) {
        position = [row.posted_us as string, row.thesis_id as string];
        const launch = launches.get(row.launch_id as string);
        if (launch)
          hits.push({
            hit: { thesis: publicPost(postFromRow(row)), launch },
            position,
          });
        if (hits.length > limit) break;
      }
    }
    const page = hits.slice(0, limit);
    // A full page resumes after its last hit; a short one that stopped reading early, after the last post read.
    const resume =
      hits.length > limit ? page.at(-1)?.position : exhausted ? null : position;
    return {
      theses: page.map(({ hit }) => hit),
      nextCursor: resume ? encodeCursor(shape, [resume[0]], [resume[1]]) : null,
    };
  });
}
