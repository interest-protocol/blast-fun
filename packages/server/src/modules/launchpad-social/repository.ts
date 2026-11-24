import type { Disclosure } from "@blast/core/modules/launchpad-social/post-contract.ts";
import type { QueryResultRow } from "pg";

import type {
  ModuleTransaction,
  ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import type { LaunchIdentity } from "@blast/core/modules/launchpad-social/launch-identity.ts";
import {
  authorLabels,
  searchText,
  type HolderProof,
} from "@blast/server/modules/launchpad-social/contracts.ts";
import type {
  PostInput,
  PostKind,
  ThesisStance,
  Visibility,
} from "@blast/core/modules/launchpad-social/post-contract.ts";
import {
  SOCIAL_LIMITS,
  type SocialLimits,
} from "@blast/core/modules/launchpad-social/limits.ts";

/**
 * The `launchpad-social` module's SQL. Social tables never hold a chain fact:
 * a canonical launch is a `blast_curve` pool in blast-infra's
 * `chain_read_v1.pools` with its coin in `chain_read_v1.coins`, checked in the
 * writing transaction and joined by every public read.
 */

export type SocialTransaction = ModuleTransaction<"launchpad-social">;

/** Spec §6.9's disclosure: the author's text, a disclosed wallet and its verification. */
/** A post as spec §6.9 models it, plus its thesis, revision, first-post time and provenance. */
export type PostRecord = Readonly<{
  id: string;
  thesisId: string;
  revisionOf: string | null;
  launchId: string;
  kind: PostKind;
  stance: ThesisStance | null;
  /** Opaque: never the Privy subject or a wallet. */
  authorIdentityId: string;
  body: string;
  evidenceLinks: readonly string[];
  disclosure: Disclosure;
  authorLabels: readonly string[];
  /** The deployment and committed checkpoint at which the launch was canonical when written. */
  provenance: Readonly<{
    network: string;
    deployment: string;
    checkpoint: number;
  }>;
  /** When the post was first posted (server time); a revision keeps it. */
  postedAt: string;
  /** When this record was written (server time). */
  createdAt: string;
  moderationState: Visibility;
  moderationChangedAt: string | null;
}>;

/** The durable identity behind an author: never public. */
export type AuthorIdentity = Readonly<{
  method: "privy" | "wallet_proof";
  subjectKey: string | null;
  walletAddress: string | null;
}>;

/** A record as its audit sees it: every field and the author's identity. */
export type AuditRecord = PostRecord & Readonly<{ author: AuthorIdentity }>;

/** A canonical launch's coin and creator, and the chain position it was read at. */
export type CanonicalLaunch = Readonly<{
  coinType: string;
  creator: string | null;
  network: string;
  deployment: string;
  checkpoint: number;
}>;

/** The launch is canonical, unknown to the views, or the views cannot vouch for anything yet. */
export type LaunchCheck =
  | Readonly<{ kind: "canonical"; launch: CanonicalLaunch }>
  | Readonly<{ kind: "unknown"; network: string; deployment: string }>
  | Readonly<{ kind: "unindexed" }>;

export const POST_COLUMNS = `t.record_id, t.thesis_id, t.revision_of, t.launch_id, t.kind, t.stance,
  t.author_identity_id, t.body, t.evidence_links, t.disclosure_text, t.disclosure_wallet, t.verification,
  t.observed_checkpoint::text AS observed_checkpoint, t.observed_at, t.network, t.deployment_fingerprint,
  t.launch_checkpoint::text AS launch_checkpoint, t.thesis_created_at, t.created_at, t.visibility,
  t.visibility_changed_at`;

/** A record whose post has a newer record is no longer its post's current one. */
export const IS_CURRENT = `NOT EXISTS (
  SELECT 1 FROM mission_control_launchpad_theses n WHERE n.revision_of = t.record_id
)`;

export const LAUNCH_IDENTITY_COLUMNS = `c.coin_type, c.name, c.symbol, c.icon_url, p.lifecycle, c.creator,
  p.created_at_ms AS launch_created_at_ms`;

export function launchIdentityFromRow(row: QueryResultRow): LaunchIdentity {
  return {
    launchId: row.launch_id,
    coinType: row.coin_type,
    name: row.name,
    symbol: row.symbol,
    iconUrl: row.icon_url,
    lifecycle: row.lifecycle,
    creator: row.creator,
    createdAtMs: Number(row.launch_created_at_ms),
  };
}

function iso(value: unknown): string | null {
  return value === null ? null : (value as Date).toISOString();
}

export function postFromRow(row: QueryResultRow): PostRecord {
  const disclosure: Disclosure = {
    text: row.disclosure_text,
    walletAddress: row.disclosure_wallet,
    verification: row.verification,
    observedCheckpoint: row.observed_checkpoint,
    observedAt: iso(row.observed_at),
  };
  return {
    id: row.record_id,
    thesisId: row.thesis_id,
    revisionOf: row.revision_of,
    launchId: row.launch_id,
    kind: row.kind,
    stance: row.stance,
    authorIdentityId: row.author_identity_id,
    body: row.body,
    evidenceLinks: row.evidence_links,
    disclosure,
    authorLabels: authorLabels({ kind: row.kind, disclosure }),
    provenance: {
      network: row.network,
      deployment: row.deployment_fingerprint,
      checkpoint: Number(row.launch_checkpoint),
    },
    postedAt: iso(row.thesis_created_at) as string,
    createdAt: iso(row.created_at) as string,
    moderationState: row.visibility,
    moderationChangedAt: iso(row.visibility_changed_at),
  };
}

/**
 * Whether `launchId` is canonical now, read through the chain views in the
 * caller's transaction, with its coin, its creator and the watermark's
 * deployment and checkpoint.
 */
export async function checkLaunch(
  database: ReadableDatabase,
  launchId: string,
): Promise<LaunchCheck> {
  const result = await database.read<{
    network: string;
    deployment_fingerprint: string;
    checkpoint: string | null;
    coin_type: string | null;
    creator: string | null;
  }>(
    `SELECT w.network, w.deployment_fingerprint, w.checkpoint::text AS checkpoint, l.coin_type, l.creator
     FROM chain_read_v1.watermark w
     LEFT JOIN (
       SELECT p.coin_type, c.creator
       FROM chain_read_v1.pools p
       JOIN chain_read_v1.coins c ON c.coin_type = p.coin_type
       WHERE p.pool_key = 'blast_curve:' || $1 AND p.venue = 'blast_curve'
     ) l ON TRUE`,
    [launchId],
  );
  const row = result.rows[0];
  if (!row || row.checkpoint === null) return { kind: "unindexed" };
  if (row.coin_type === null)
    return {
      kind: "unknown",
      network: row.network,
      deployment: row.deployment_fingerprint,
    };
  return {
    kind: "canonical",
    launch: {
      coinType: row.coin_type,
      creator: row.creator,
      network: row.network,
      deployment: row.deployment_fingerprint,
      checkpoint: Number(row.checkpoint),
    },
  };
}

/** The opaque identity of an author, created on their first post. */
export async function authorIdentity(
  transaction: SocialTransaction,
  author: AuthorIdentity,
  createId: () => string,
): Promise<string> {
  await transaction.write(
    "mission_control_launchpad_social_authors",
    `INSERT INTO mission_control_launchpad_social_authors (author_identity_id, author_method, author_subject_key, author_wallet)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (identity_key) DO NOTHING`,
    [createId(), author.method, author.subjectKey, author.walletAddress],
  );
  const result = await transaction.read<{ author_identity_id: string }>(
    "SELECT author_identity_id FROM mission_control_launchpad_social_authors WHERE identity_key = $1",
    [`${author.method}:${author.subjectKey ?? author.walletAddress}`],
  );
  return result.rows[0].author_identity_id;
}

/** One record by ID, any visibility; `lock` holds it until the transaction ends. */
export async function readRecord(
  database: ReadableDatabase,
  recordId: string,
  options: Readonly<{ lock?: boolean }> = {},
): Promise<(PostRecord & { current: boolean }) | null> {
  const result = await database.read(
    `SELECT ${POST_COLUMNS}, ${IS_CURRENT} AS current
     FROM mission_control_launchpad_theses t
     WHERE t.record_id = $1${options.lock ? " FOR UPDATE OF t" : ""}`,
    [recordId],
  );
  const row = result.rows[0];
  return row ? { ...postFromRow(row), current: row.current === true } : null;
}

export type NewPost = Readonly<{
  recordId: string;
  /** The record this one revises; null for a new post. */
  revisionOf: string | null;
  authorIdentityId: string;
  input: PostInput;
  holderProof: HolderProof;
  launch: CanonicalLaunch;
}>;

/**
 * Inserts one immutable record at server time. A revision takes its thesis ID
 * and first-post time from the revised record, exactly (microseconds), and the
 * database refuses one whose launch, kind or author differs.
 */
export async function insertPost(
  transaction: SocialTransaction,
  post: NewPost,
): Promise<PostRecord> {
  const { input, holderProof, launch } = post;
  const observed =
    holderProof.verification === "verified_holder" ||
    holderProof.verification === "not_holder"
      ? holderProof
      : null;
  const result = await transaction.write(
    "mission_control_launchpad_theses",
    `INSERT INTO mission_control_launchpad_theses AS t (
       record_id, thesis_id, revision_of, launch_id, kind, stance, author_identity_id, body, evidence_links,
       disclosure_text, disclosure_wallet, verification, observed_checkpoint, observed_at, network,
       deployment_fingerprint, launch_checkpoint, thesis_created_at
     ) VALUES (
       $1,
       COALESCE((SELECT r.thesis_id FROM mission_control_launchpad_theses r WHERE r.record_id = $2), $1),
       $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       TIMESTAMPTZ 'epoch' + $13::bigint * INTERVAL '1 millisecond', $14, $15, $16,
       COALESCE((SELECT r.thesis_created_at FROM mission_control_launchpad_theses r WHERE r.record_id = $2), NOW())
     )
     RETURNING ${POST_COLUMNS}`,
    [
      post.recordId,
      post.revisionOf,
      input.launchId,
      input.kind,
      input.stance,
      post.authorIdentityId,
      input.body,
      input.evidenceLinks,
      input.disclosure.text,
      input.disclosure.walletAddress,
      holderProof.verification,
      observed?.checkpoint ?? null,
      observed?.observedAtMs ?? null,
      launch.network,
      launch.deployment,
      launch.checkpoint,
    ],
  );
  return postFromRow(result.rows[0]);
}

/**
 * Materializes a record's search row while it is public and current;
 * otherwise nothing is written. The row holds the bounded search text and the
 * launch ID, no chain fact. It is not gated on the chain views: a post is
 * written only for a canonical launch, and search joins the views again at
 * read time, so a record restored while its launch is briefly absent (a
 * replay) still matches once the launch is back.
 */
export async function materializeSearchDocument(
  transaction: SocialTransaction,
  record: PostRecord,
  limits: SocialLimits = SOCIAL_LIMITS,
): Promise<void> {
  const text = searchText(record.body, limits);
  if (text.length === 0) return;
  await transaction.write(
    "mission_control_launchpad_search_documents",
    `INSERT INTO mission_control_launchpad_search_documents (record_id, launch_id, search_text)
     SELECT t.record_id, t.launch_id, $2
     FROM mission_control_launchpad_theses t
     WHERE t.record_id = $1 AND t.visibility = 'public' AND ${IS_CURRENT}
     ON CONFLICT (record_id) DO NOTHING`,
    [record.id, text],
  );
}

export async function removeSearchDocument(
  transaction: SocialTransaction,
  recordId: string,
): Promise<void> {
  await transaction.write(
    "mission_control_launchpad_search_documents",
    "DELETE FROM mission_control_launchpad_search_documents WHERE record_id = $1",
    [recordId],
  );
}
