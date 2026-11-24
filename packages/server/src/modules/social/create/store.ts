import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";

import { createHash } from "node:crypto";

import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  CREATE_DRAFT_PAGE_DEFAULT_LIMIT,
  CREATE_DRAFT_PAGE_MAX_LIMIT,
  CREATE_QUOTE_TYPE,
  type CreateAllowlistSummary,
  type CreateDraft,
  type CreateDraftListItem,
  type CreateDraftPage,
} from "@blast/core/modules/social/contracts/create.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { StoredCover } from "@blast/server/modules/social/sales/contracts.ts";
import { storedCoverOf } from "@blast/server/modules/social/sales/store.ts";
import { normalizeSaleLink, normalizeTelegram, normalizeXHandle } from "@blast/core/modules/social/sales/validate.ts";

/**
 * The web runtime's side of `social_presale_drafts` (0068). Every statement
 * is keyed by the account id the route kit resolved, so a caller only ever
 * reaches its own drafts; another account's id reads as not found.
 */

export type DraftRow = Readonly<{
  draftId: string;
  version: number;
  body: unknown;
  logoUrl: string | null;
  /** R3-25: the sale's cover (its key included, for the store), or null. */
  cover: StoredCover | null;
  /** R3-25: the sale this draft became, once recorded. */
  publishedPresaleId: string | null;
  allowlist: CreateAllowlistSummary | null;
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
  published_presale_id: string | null;
  /** As stored: a list saved before R3-42 has no `quote_type`. */
  allowlist: (Omit<CreateAllowlistSummary, "quote_type"> & Partial<Pick<CreateAllowlistSummary, "quote_type">>) | null;
  created_at_ms: string;
  updated_at_ms: string;
};

const COLUMNS = `draft_id::text, version, body, logo_url, cover_key, cover_url, cover_width, cover_height, cover_source_width,
  cover_source_height, published_presale_id, allowlist,
  (extract(epoch FROM created_at) * 1000)::bigint::text AS created_at_ms,
  (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms`;

const toRow = (row: RawRow): DraftRow => ({
  draftId: row.draft_id,
  version: row.version,
  body: row.body,
  logoUrl: row.logo_url,
  cover: storedCoverOf(row),
  publishedPresaleId: row.published_presale_id,
  // R3-42: a list stored before lists named their coin was uploaded for USDC, the only quote Create raised then.
  allowlist: row.allowlist ? { ...row.allowlist, quote_type: row.allowlist.quote_type ?? CREATE_QUOTE_TYPE } : null,
  createdAtMs: Number(row.created_at_ms),
  updatedAtMs: Number(row.updated_at_ms),
});

/**
 * R3-25: the draft's details as its columns hold them: the quote, and each
 * link once it is valid (`sales/validate.ts`), else NULL. The body keeps
 * what was typed.
 */
export function draftDetailColumns(draft: CreateDraft): readonly (string | null)[] {
  const valid = (normalized: { ok: boolean; value?: string | null }) => (normalized.ok ? (normalized.value ?? null) : null);
  return [
    draft.quote_type,
    valid(normalizeSaleLink(draft.site)),
    valid(normalizeXHandle(draft.x_handle)),
    valid(normalizeTelegram(draft.telegram)),
    valid(normalizeSaleLink(draft.docs_url)),
    valid(normalizeSaleLink(draft.audit_url)),
  ];
}

const READ_SQL = `SELECT ${COLUMNS} FROM social_presale_drafts WHERE draft_id = $1 AND account_id = $2`;

/** The account's draft, or null (unknown, or another account's). */
export async function readDraft(db: ReadableDatabase, accountId: string, draftId: string): Promise<DraftRow | null> {
  const { rows } = await db.read<RawRow>(READ_SQL, [draftId, accountId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** One writer at a time per account: creates count the account's drafts under it. */
const LOCK_ACCOUNT = "SELECT pg_advisory_xact_lock(hashtext('social_presale_drafts'), hashtext($1))";
const COUNT_SQL = "SELECT count(*)::int AS drafts FROM social_presale_drafts WHERE account_id = $1 AND published_presale_id IS NULL";
/**
 * A draft id is one draft's across both draft tables: Launch drafts share the
 * `draft-covers/<draft_id>` cover folder (`sales/cover.ts`), so an id a launch draft holds is not found here.
 */
const INSERT_SQL = `INSERT INTO social_presale_drafts (draft_id, account_id, version, body, allowlist, quote_type, site, x_handle, telegram, docs_url, audit_url)
  SELECT $1, $2, 1, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10
  WHERE NOT EXISTS (SELECT 1 FROM social_launch_drafts WHERE draft_id = $1::uuid)
  ON CONFLICT (draft_id) DO NOTHING
  RETURNING ${COLUMNS}`;
const UPDATE_SQL = `UPDATE social_presale_drafts
  SET body = $4::jsonb, allowlist = $5::jsonb, quote_type = $6, site = $7, x_handle = $8, telegram = $9, docs_url = $10, audit_url = $11,
    version = version + 1, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND version = $3 AND published_presale_id IS NULL
  RETURNING ${COLUMNS}`;

export type SaveOutcome =
  | Readonly<{ kind: "saved"; row: DraftRow }>
  /** The draft exists at another version: `stored` is what is there. */
  | Readonly<{ kind: "conflict"; stored: DraftRow }>
  | Readonly<{ kind: "not_found" }>;

/**
 * Creates (`version` 0) or replaces (`version` = the stored one) a draft in
 * one transaction. A create beyond `limit` drafts is `draft_limit`; a
 * create whose id another account holds, or a replace of a draft that is
 * not there, is not found; any other version is a conflict, which the
 * route answers as a harmless retry when the stored body already equals
 * this one.
 */
export async function saveDraft(
  social: ModuleTransaction<"social">,
  input: Readonly<{
    accountId: string;
    draftId: string;
    version: number;
    draft: CreateDraft;
    allowlist: CreateAllowlistSummary | null;
    limit: number;
  }>,
): Promise<SaveOutcome> {
  const body = JSON.stringify(input.draft);
  const allowlist = input.allowlist ? JSON.stringify(input.allowlist) : null;
  if (input.version === 0) {
    await social.read(LOCK_ACCOUNT, [input.accountId]);
    const existing = await readDraft(social, input.accountId, input.draftId);
    if (existing) return { kind: "conflict", stored: existing };
    const { rows: counted } = await social.read<{ drafts: number }>(COUNT_SQL, [input.accountId]);
    if ((counted[0]?.drafts ?? 0) >= input.limit) throw new SocialRouteError("draft_limit");
    const { rows } = await social.write<RawRow>("social_presale_drafts", INSERT_SQL, [input.draftId, input.accountId, body, allowlist, ...draftDetailColumns(input.draft)]);
    return rows[0] ? { kind: "saved", row: toRow(rows[0]) } : { kind: "not_found" };
  }
  const { rows } = await social.write<RawRow>("social_presale_drafts", UPDATE_SQL, [
    input.draftId, input.accountId, input.version, body, allowlist, ...draftDetailColumns(input.draft),
  ]);
  if (rows[0]) return { kind: "saved", row: toRow(rows[0]) };
  const stored = await readDraft(social, input.accountId, input.draftId);
  return stored ? { kind: "conflict", stored } : { kind: "not_found" };
}

const LOGO_SQL = `UPDATE social_presale_drafts
  SET logo_url = $3, version = version + 1, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2
  RETURNING ${COLUMNS}`;

/** Sets the draft's logo (a new version); null when the draft is not the account's. */
export async function setDraftLogo(social: ModuleTransaction<"social">, accountId: string, draftId: string, url: string): Promise<DraftRow | null> {
  const { rows } = await social.write<RawRow>("social_presale_drafts", LOGO_SQL, [draftId, accountId, url]);
  return rows[0] ? toRow(rows[0]) : null;
}

const COVER_SQL = `UPDATE social_presale_drafts
  SET cover_key = $3, cover_url = $4, cover_width = $5, cover_height = $6, cover_source_width = $7, cover_source_height = $8,
    version = version + 1, updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND published_presale_id IS NULL
  RETURNING ${COLUMNS}`;

/**
 * R3-25: sets (or, with null, removes) the draft's cover, a new version,
 * under the row's lock; answers the row and the cover it replaced, or null
 * when the draft is not the account's or is published (its cover is then
 * the sale's).
 */
export async function setDraftCover(
  social: ModuleTransaction<"social">,
  accountId: string,
  draftId: string,
  cover: StoredCover | null,
): Promise<Readonly<{ row: DraftRow; replaced: StoredCover | null }> | null> {
  const { rows: before } = await social.read<RawRow>(`${READ_SQL} FOR UPDATE`, [draftId, accountId]);
  if (!before[0] || before[0].published_presale_id !== null) return null;
  const { rows } = await social.write<RawRow>("social_presale_drafts", COVER_SQL, [
    draftId, accountId, cover?.key ?? null, cover?.url ?? null, cover?.width ?? null, cover?.height ?? null,
    cover?.source?.width ?? null, cover?.source?.height ?? null,
  ]);
  return rows[0] ? { row: toRow(rows[0]), replaced: toRow(before[0]).cover } : null;
}

const PUBLISHED_SQL = `UPDATE social_presale_drafts
  SET published_presale_id = $3, published_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE draft_id = $1 AND account_id = $2 AND published_presale_id IS NULL
  RETURNING ${COLUMNS}`;

export type PublishedOutcome =
  | Readonly<{ kind: "recorded"; row: DraftRow }>
  /** Recorded before as this same sale: nothing is written again. */
  | Readonly<{ kind: "already"; row: DraftRow }>
  /** Recorded as another sale, or the sale is another draft's. */
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "not_found" }>;

/** R3-25: records, once, that the account's draft became `presaleId`. */
export async function recordDraftPublished(
  social: ModuleTransaction<"social">,
  accountId: string,
  draftId: string,
  presaleId: string,
): Promise<PublishedOutcome> {
  const stored = await social.read<RawRow>(`${READ_SQL} FOR UPDATE`, [draftId, accountId]);
  const current = stored.rows[0];
  if (!current) return { kind: "not_found" };
  if (current.published_presale_id === presaleId) return { kind: "already", row: toRow(current) };
  if (current.published_presale_id !== null) return { kind: "conflict" };
  const taken = await social.read<{ draft_id: string }>("SELECT draft_id::text FROM social_presale_drafts WHERE published_presale_id = $1", [presaleId]);
  if (taken.rows.length > 0) return { kind: "conflict" };
  const { rows } = await social.write<RawRow>("social_presale_drafts", PUBLISHED_SQL, [draftId, accountId, presaleId]);
  return rows[0] ? { kind: "recorded", row: toRow(rows[0]) } : { kind: "conflict" };
}

const DELETE_SQL = "DELETE FROM social_presale_drafts WHERE draft_id = $1 AND account_id = $2 AND published_presale_id IS NULL";

/** Removes an unpublished draft; publication records remain part of discovery. */
export async function deleteDraft(social: ModuleTransaction<"social">, accountId: string, draftId: string): Promise<boolean> {
  return ((await social.write("social_presale_drafts", DELETE_SQL, [draftId, accountId])).rowCount ?? 0) > 0;
}

// ---- the list: most recently saved first, keyset (updated_at, draft_id) ----

const CURSOR_VERSION = 1;
const CHECK_LENGTH = 12;
const check = (body: string) => createHash("sha256").update(`social-draft-cursor:${body}`).digest("base64url").slice(0, CHECK_LENGTH);
const invalid = (name: string) => new SocialRouteError("invalid_parameter", { extra: { parameter: name } });
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DraftCursor = Readonly<{ updatedAt: string; draftId: string }>;

/** The opaque cursor after a page's last row (its exact `updated_at`, to the microsecond, and id). */
export function encodeDraftCursor(position: DraftCursor): string {
  const body = Buffer.from(JSON.stringify([CURSOR_VERSION, position.updatedAt, position.draftId]), "utf8").toString("base64url");
  return `${body}.${check(body)}`;
}

/** The position a cursor names; anything this codec did not produce is `invalid_parameter` (`cursor`). */
const draftCursorSchema = z.tuple([
  z.literal(CURSOR_VERSION), z.string().regex(TIMESTAMP), z.string().regex(UUID),
]);

export function decodeDraftCursor(cursor: string): DraftCursor {
  if (cursor.length > 256) throw invalid("cursor");
  const [body, value, ...rest] = cursor.split(".");
  if (rest.length || !body || !value || !/^[A-Za-z0-9_-]+$/.test(body) || value !== check(body)) throw invalid("cursor");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalid("cursor");
  }
  const parsed = draftCursorSchema.safeParse(decoded);
  if (!parsed.success) throw invalid("cursor");
  const [, updatedAt, draftId] = parsed.data;
  return { updatedAt, draftId };
}

export type DraftPageRequest = Readonly<{ limit: number; after: DraftCursor | null; resume: boolean }>;

/** `resume=true` limits automatic restoration to edits made since the latest publication. */
export function parseDraftPage(searchParams: URLSearchParams): DraftPageRequest {
  for (const key of searchParams.keys()) if (key !== "limit" && key !== "cursor" && key !== "resume") throw invalid(key);
  const rawLimit = searchParams.get("limit");
  const limit = socialParameter(z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(CREATE_DRAFT_PAGE_MAX_LIMIT)).nullable().transform((value) => value ?? CREATE_DRAFT_PAGE_DEFAULT_LIMIT), rawLimit, "limit");
  const cursor = searchParams.get("cursor");
  const resume = searchParams.get("resume");
  socialParameter(z.enum(["true", "false"]).nullable(), resume, "resume");
  return { limit, after: cursor === null ? null : decodeDraftCursor(cursor), resume: resume === "true" };
}

const PAGE_SQL = `
  SELECT draft_id::text AS id, version,
    COALESCE(body->>'name', '') AS name, COALESCE(body->>'symbol', '') AS symbol,
    COALESCE((body->>'target')::numeric, 0)::float8 AS target, logo_url,
    (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms,
    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
  FROM social_presale_drafts
  WHERE account_id = $1 AND published_presale_id IS NULL
    AND (NOT $5::boolean OR updated_at > COALESCE(
      (SELECT MAX(published_at) FROM social_presale_drafts WHERE account_id = $1), '-infinity'::timestamptz))
    AND ($2::timestamptz IS NULL OR (updated_at, draft_id) < ($2::timestamptz, $3::uuid))
  ORDER BY updated_at DESC, draft_id DESC
  LIMIT $4`;

type PageRow = { id: string; version: number; name: string; symbol: string; target: number; logo_url: string | null; updated_at_ms: string; updated_at: string };

/** A page of the account's unfinished drafts, optionally restricted to current work. */
export async function readDraftPage(db: ReadableDatabase, accountId: string, page: DraftPageRequest): Promise<CreateDraftPage> {
  const { rows } = await db.read<PageRow>(PAGE_SQL, [accountId, page.after?.updatedAt ?? null, page.after?.draftId ?? null, page.limit + 1, page.resume]);
  const more = rows.length > page.limit;
  const items: CreateDraftListItem[] = rows.slice(0, page.limit).map((row) => ({
    draft_id: row.id,
    version: row.version,
    name: row.name,
    symbol: row.symbol,
    target: row.target,
    logo_url: row.logo_url,
    updated_at_ms: Number(row.updated_at_ms),
  }));
  const last = rows[page.limit - 1];
  return { items, next_cursor: more && last ? encodeDraftCursor({ updatedAt: last.updated_at, draftId: last.id }) : null };
}
