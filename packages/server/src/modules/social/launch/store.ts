import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { LaunchDraftSummary, LaunchPublishPlan, LaunchPublishStepKind } from "@blast/core/modules/social/contracts/launch.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { LaunchDraft } from "@blast/core/modules/social/launch/model.ts";
import type { StoredCover } from "@blast/server/modules/social/sales/contracts.ts";
import { storedCoverOf } from "@blast/server/modules/social/sales/store.ts";

/**
 * The web runtime's side of `social_launch_drafts` (0148). Every statement
 * is keyed by the account id the route kit resolved, so a caller only ever
 * reaches its own drafts; another account's id reads as not found.
 */

export type LaunchCreatorX = Readonly<{ commitment: Buffer; subject: string }>;

export type LaunchStepPlan = Readonly<{ digest: string; plan: LaunchPublishPlan }>;
export type LaunchPublication = Readonly<{ creator: string; fee: "wallet" | "sponsored"; steps: Partial<Record<LaunchPublishStepKind, LaunchStepPlan>> }>;

export type LaunchDraftRow = Readonly<{
  draftId: string;
  version: number;
  body: unknown;
  logoUrl: string | null;
  cover: StoredCover | null;
  /** The coin the draft published, once a later step named it. */
  coinType: string | null;
  creatorX: LaunchCreatorX | null;
  publication: LaunchPublication | null;
  publishedLaunchId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}>;

type RawRow = {
  draft_id: string;
  version: number;
  body: unknown;
  logo_url: string | null;
  cover_key: string | null;
  cover_url: string | null;
  cover_width: number | null;
  cover_height: number | null;
  cover_source_width: number | null;
  cover_source_height: number | null;
  coin_type: string | null;
  creator_x_subject: string | null;
  creator_x_commitment: Buffer | null;
  publication: LaunchPublication | null;
  published_launch_id: string | null;
  created_at_ms: string;
  updated_at_ms: string;
};

const TABLE = "social_launch_drafts";
const COLUMNS = `draft_id::text, version, body, logo_url, cover_key, cover_url, cover_width, cover_height, cover_source_width,
  cover_source_height, coin_type, creator_x_subject, creator_x_commitment, publication, published_launch_id,
  (extract(epoch FROM created_at) * 1000)::bigint::text AS created_at_ms,
  (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms`;

const toRow = (row: RawRow): LaunchDraftRow => ({
  draftId: row.draft_id,
  version: row.version,
  body: row.body,
  logoUrl: row.logo_url,
  cover: storedCoverOf(row),
  coinType: row.coin_type,
  creatorX: row.creator_x_subject && row.creator_x_commitment
    ? { subject: row.creator_x_subject, commitment: row.creator_x_commitment }
    : null,
  publication: row.publication,
  publishedLaunchId: row.published_launch_id,
  createdAtMs: Number(row.created_at_ms),
  updatedAtMs: Number(row.updated_at_ms),
});

const READ_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE draft_id = $1 AND account_id = $2`;

export async function readLaunchDraft(db: ReadableDatabase, accountId: string, draftId: string): Promise<LaunchDraftRow | null> {
  const { rows } = await db.read<RawRow>(READ_SQL, [draftId, accountId]);
  return rows[0] ? toRow(rows[0]) : null;
}

type CreatorXRow = Readonly<{
  draft_id: string;
  account_id: string;
  published_launch_id: string | null;
  creator_x_commitment: Buffer;
  creator_x_subject: string;
  creation: LaunchStepPlan | null;
}>;

/** Prefer the confirmed launch binding. A commitment match can recover an interrupted publish. */
export async function readLaunchCreatorXRecipient(db: ReadableDatabase, launchId: string, commitment: Uint8Array): Promise<CreatorXRow | null> {
  const columns = "draft_id, account_id, published_launch_id, creator_x_commitment, creator_x_subject";
  const { rows } = await db.read<CreatorXRow>(`SELECT * FROM (
    SELECT ${columns}, NULL::jsonb AS creation FROM ${TABLE}
      WHERE published_launch_id = $1 AND creator_x_commitment IS NOT NULL
    UNION ALL
    SELECT ${columns}, publication->'steps'->'create_launch' AS creation FROM ${TABLE}
      WHERE creator_x_commitment = $2 AND published_launch_id IS DISTINCT FROM $1
  ) AS recipients ORDER BY (published_launch_id = $1) DESC NULLS LAST LIMIT 1`, [launchId, Buffer.from(commitment)]);
  return rows[0] ?? null;
}

const LIST_SQL = `SELECT draft_id::text AS id, version, COALESCE(body->>'name', '') AS name, COALESCE(body->>'symbol', '') AS symbol, logo_url,
    (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms
  FROM ${TABLE} WHERE account_id = $1 AND published_launch_id IS NULL
  ORDER BY updated_at DESC, draft_id DESC LIMIT $2`;

/** The account's unpublished drafts, most recently saved first. */
export async function listLaunchDrafts(db: ReadableDatabase, accountId: string, limit: number): Promise<LaunchDraftSummary[]> {
  const { rows } = await db.read<{ id: string; version: number; name: string; symbol: string; logo_url: string | null; updated_at_ms: string }>(LIST_SQL, [accountId, limit]);
  return rows.map((row) => ({ draft_id: row.id, version: row.version, name: row.name, symbol: row.symbol, logo_url: row.logo_url, updated_at_ms: Number(row.updated_at_ms) }));
}

const LOCK_ACCOUNT = `SELECT pg_advisory_xact_lock(hashtext('${TABLE}'), hashtext($1))`;
const COUNT_SQL = `SELECT count(*)::int AS drafts FROM ${TABLE} WHERE account_id = $1 AND published_launch_id IS NULL`;
/**
 * A draft id is one draft's across both draft tables: Create (presale) drafts share the
 * `draft-covers/<draft_id>` cover folder (`sales/cover.ts`), so an id a presale draft holds is not found here.
 */
const INSERT_SQL = `INSERT INTO ${TABLE} (draft_id, account_id, version, body)
  SELECT $1, $2, 1, $3::jsonb WHERE NOT EXISTS (SELECT 1 FROM social_presale_drafts WHERE draft_id = $1::uuid)
  ON CONFLICT (draft_id) DO NOTHING RETURNING ${COLUMNS}`;
/** A draft whose coin exists keeps its coin: the save is refused once `coin_type` is set. */
const UPDATE_SQL = `UPDATE ${TABLE} SET body = $4::jsonb, version = version + 1, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND version = $3 AND coin_type IS NULL AND publication IS NULL AND published_launch_id IS NULL
  RETURNING ${COLUMNS}`;

export type LaunchSaveOutcome =
  | Readonly<{ kind: "saved"; row: LaunchDraftRow }>
  | Readonly<{ kind: "conflict"; stored: LaunchDraftRow }>
  | Readonly<{ kind: "not_found" }>;

/**
 * Creates (`version` 0) or replaces (`version` = the stored one) a draft in
 * one transaction; a create beyond `limit` unpublished drafts is `draft_limit`.
 */
export async function saveLaunchDraft(
  social: ModuleTransaction<"social">,
  input: Readonly<{ accountId: string; draftId: string; version: number; draft: LaunchDraft; limit: number }>,
): Promise<LaunchSaveOutcome> {
  const body = JSON.stringify(input.draft);
  if (input.version === 0) {
    await social.read(LOCK_ACCOUNT, [input.accountId]);
    const existing = await readLaunchDraft(social, input.accountId, input.draftId);
    if (existing) return { kind: "conflict", stored: existing };
    const { rows: counted } = await social.read<{ drafts: number }>(COUNT_SQL, [input.accountId]);
    if ((counted[0]?.drafts ?? 0) >= input.limit) throw new SocialRouteError("draft_limit");
    const { rows } = await social.write<RawRow>(TABLE, INSERT_SQL, [input.draftId, input.accountId, body]);
    return rows[0] ? { kind: "saved", row: toRow(rows[0]) } : { kind: "not_found" };
  }
  const { rows } = await social.write<RawRow>(TABLE, UPDATE_SQL, [input.draftId, input.accountId, input.version, body]);
  if (rows[0]) return { kind: "saved", row: toRow(rows[0]) };
  const stored = await readLaunchDraft(social, input.accountId, input.draftId);
  return stored ? { kind: "conflict", stored } : { kind: "not_found" };
}

const LOGO_SQL = `UPDATE ${TABLE} SET logo_url = $3, version = version + 1, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND coin_type IS NULL AND publication IS NULL RETURNING ${COLUMNS}`;

/** Sets the logo (a new version); null when the draft is not the account's or its coin exists. */
export async function setLaunchLogo(social: ModuleTransaction<"social">, accountId: string, draftId: string, url: string): Promise<LaunchDraftRow | null> {
  const { rows } = await social.write<RawRow>(TABLE, LOGO_SQL, [draftId, accountId, url]);
  return rows[0] ? toRow(rows[0]) : null;
}

const COVER_SQL = `UPDATE ${TABLE}
  SET cover_key = $3, cover_url = $4, cover_width = $5, cover_height = $6, cover_source_width = $7, cover_source_height = $8,
    version = version + 1, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 RETURNING ${COLUMNS}`;

/** Sets (or, with null, removes) the cover under the row's lock; answers the row and the cover it replaced. */
export async function setLaunchCover(
  social: ModuleTransaction<"social">,
  accountId: string,
  draftId: string,
  cover: StoredCover | null,
): Promise<Readonly<{ row: LaunchDraftRow; replaced: StoredCover | null }> | null> {
  const { rows: before } = await social.read<RawRow>(`${READ_SQL} FOR UPDATE`, [draftId, accountId]);
  if (!before[0]) return null;
  if (before[0].publication !== null) throw new SocialRouteError("draft_published");
  const { rows } = await social.write<RawRow>(TABLE, COVER_SQL, [
    draftId, accountId, cover?.key ?? null, cover?.url ?? null, cover?.width ?? null, cover?.height ?? null,
    cover?.source?.width ?? null, cover?.source?.height ?? null,
  ]);
  return rows[0] ? { row: toRow(rows[0]), replaced: toRow(before[0]).cover } : null;
}

const COIN_SQL = `UPDATE ${TABLE} SET coin_type = $3, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND coin_type IS NULL AND publication IS NOT NULL RETURNING ${COLUMNS}`;

/**
 * Records, once, the coin the draft's first transaction published. A second,
 * different coin is a conflict: one draft never launches two coins.
 */
export async function recordLaunchCoin(social: ModuleTransaction<"social">, accountId: string, draftId: string, coinType: string): Promise<"recorded" | "already" | "conflict" | "not_found"> {
  const { rows: before } = await social.read<RawRow>(`${READ_SQL} FOR UPDATE`, [draftId, accountId]);
  const current = before[0];
  if (!current) return "not_found";
  if (current.coin_type === coinType) return "already";
  if (current.coin_type !== null) return "conflict";
  const { rows } = await social.write<RawRow>(TABLE, COIN_SQL, [draftId, accountId, coinType]);
  return rows[0] ? "recorded" : "conflict";
}

const PUBLISHED_SQL = `UPDATE ${TABLE} SET published_launch_id = $3, published_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND published_launch_id IS NULL AND coin_type IS NOT NULL RETURNING ${COLUMNS}`;

export type LaunchPublishedOutcome =
  | Readonly<{ kind: "recorded" | "already"; row: LaunchDraftRow }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "not_found" }>;

/** Records, once, the launch the draft became. */
export async function recordLaunchPublished(social: ModuleTransaction<"social">, accountId: string, draftId: string, launchId: string): Promise<LaunchPublishedOutcome> {
  const { rows: before } = await social.read<RawRow>(`${READ_SQL} FOR UPDATE`, [draftId, accountId]);
  const current = before[0];
  if (!current) return { kind: "not_found" };
  if (current.published_launch_id === launchId) return { kind: "already", row: toRow(current) };
  if (current.published_launch_id !== null || current.coin_type === null) return { kind: "conflict" };
  const taken = await social.read<{ draft_id: string }>(`SELECT draft_id::text FROM ${TABLE} WHERE published_launch_id = $1`, [launchId]);
  if (taken.rows.length > 0) return { kind: "conflict" };
  const { rows } = await social.write<RawRow>(TABLE, PUBLISHED_SQL, [draftId, accountId, launchId]);
  return rows[0] ? { kind: "recorded", row: toRow(rows[0]) } : { kind: "conflict" };
}

const DELETE_SQL = `DELETE FROM ${TABLE} WHERE draft_id = $1 AND account_id = $2 AND coin_type IS NULL AND publication IS NULL`;

/** Removes a draft whose coin was never published; a published coin's draft stays as its record. */
export async function deleteLaunchDraft(social: ModuleTransaction<"social">, accountId: string, draftId: string): Promise<boolean> {
  return ((await social.write(TABLE, DELETE_SQL, [draftId, accountId])).rowCount ?? 0) > 0;
}

/** Only the winner is returned to a signer. Every retry returns the same executable bytes. */
export async function saveLaunchPublication(social: ModuleTransaction<"social">, accountId: string, draftId: string, version: number, creator: string, fee: LaunchPublication["fee"], step: LaunchPublishStepKind, proposed: LaunchStepPlan, replaces: string | null, creatorX: LaunchCreatorX | null): Promise<LaunchStepPlan> {
  const { rows } = await social.read<RawRow>(`${READ_SQL} FOR UPDATE`, [draftId, accountId]);
  const row = rows[0];
  if (!row) throw new SocialRouteError("not_found");
  if (row.version !== version || row.published_launch_id !== null) throw new SocialRouteError("draft_conflict");
  const publication = row.publication ?? { creator, fee, steps: {} };
  if (publication.creator !== creator || publication.fee !== fee) throw new SocialRouteError("draft_published");
  const current = publication.steps[step];
  if (current && current.digest !== replaces) return current;
  const next = { ...publication, steps: { ...publication.steps, [step]: proposed } };
  await social.write(TABLE, `UPDATE ${TABLE}
    SET publication = $3::jsonb, updated_at = clock_timestamp(),
      creator_x_subject = COALESCE(creator_x_subject, $4),
      creator_x_commitment = COALESCE(creator_x_commitment, $5)
    WHERE draft_id = $1 AND account_id = $2`,
  [draftId, accountId, JSON.stringify(next), creatorX?.subject ?? null, creatorX?.commitment ?? null]);
  return proposed;
}
