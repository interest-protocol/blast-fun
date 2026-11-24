import { z } from "zod";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SALE_METADATA_FIELDS, type SaleMetadataField, type SocialSaleCover, type SocialSaleMetadata } from "@blast/core/modules/social/contracts/sales.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import type { StoredCover } from "@blast/server/modules/social/sales/contracts.ts";

/**
 * The web runtime's side of `social_sale_metadata` and its insert-only edit
 * log (0090). A write takes the sale's advisory lock, compares the change
 * with what is stored, and only when something differs appends one edit row
 * (the fields before) and upserts the row, in the same transaction: the same
 * request twice stores one edit, and two writers never interleave.
 */

/** A row's values, as stored: the public fields plus the cover's key, which the public reads never show. */
export type StoredSaleMetadata = Readonly<Record<SaleMetadataField, string | null> & {
  launch_at_ms: number | null;
  cover: StoredCover | null;
}>;

export const EMPTY_STORED_SALE_METADATA: StoredSaleMetadata = Object.freeze({
  tagline: null,
  site: null,
  x_handle: null,
  telegram: null,
  docs_url: null,
  audit_url: null,
  launch_at_ms: null,
  cover: null,
});

/** Who changed a row: the sale's creator (an account) or an operator. */
export type SaleMetadataAuthor = Readonly<{ accountId: string }> | Readonly<{ operatorId: string }>;

/** The columns a row is read with (`m` the table's alias). */
export const SALE_METADATA_COLUMNS = (alias: string) => `${alias}.tagline, ${alias}.site, ${alias}.x_handle, ${alias}.telegram,
  ${alias}.docs_url, ${alias}.audit_url, ${alias}.launch_at_ms::text AS launch_at_ms, ${alias}.cover_key, ${alias}.cover_url,
  ${alias}.cover_width, ${alias}.cover_height, ${alias}.cover_source_width, ${alias}.cover_source_height`;

/**
 * The details of the sale `presaleColumn` names, as `m` (`SALE_METADATA_COLUMNS("m")` reads it):
 * one primary-key probe per sale. A lateral subquery with a `LIMIT` is never pulled up into a
 * join, so the planner cannot trade the probes for a scan of the whole table, however small.
 */
export function saleMetadataJoinSql(presaleColumn: string): string {
  return `LEFT JOIN LATERAL (
    SELECT sm.tagline, sm.site, sm.x_handle, sm.telegram, sm.docs_url, sm.audit_url, sm.launch_at_ms,
      sm.cover_key, sm.cover_url, sm.cover_width, sm.cover_height, sm.cover_source_width, sm.cover_source_height
    FROM social_sale_metadata sm WHERE sm.presale_id = ${presaleColumn} LIMIT 1
  ) m ON TRUE`;
}

export type SaleMetadataRow = Readonly<Record<SaleMetadataField, string | null> & {
  launch_at_ms: string | null;
  cover_key: string | null;
  cover_url: string | null;
  cover_width: number | null;
  cover_height: number | null;
  cover_source_width: number | null;
  cover_source_height: number | null;
}>;

/** The cover a row's columns name, all four or none, with its upload's size when recorded. */
export function storedCoverOf(row: Pick<SaleMetadataRow, "cover_key" | "cover_url" | "cover_width" | "cover_height" | "cover_source_width" | "cover_source_height">): StoredCover | null {
  if (!row.cover_key || !row.cover_url || !row.cover_width || !row.cover_height) return null;
  const source = row.cover_source_width && row.cover_source_height ? { width: row.cover_source_width, height: row.cover_source_height } : null;
  return { key: row.cover_key, url: row.cover_url, width: row.cover_width, height: row.cover_height, source };
}

/** A stored cover's public shape: never its key. */
export function publicCover(cover: StoredCover | null): SocialSaleCover | null {
  return cover ? { url: cover.url, width: cover.width, height: cover.height, source: cover.source } : null;
}

export function storedOf(row: SaleMetadataRow | null | undefined): StoredSaleMetadata {
  if (!row) return EMPTY_STORED_SALE_METADATA;
  return {
    tagline: row.tagline,
    site: row.site,
    x_handle: row.x_handle,
    telegram: row.telegram,
    docs_url: row.docs_url,
    audit_url: row.audit_url,
    launch_at_ms: row.launch_at_ms === null ? null : Number(row.launch_at_ms),
    cover: storedCoverOf(row),
  };
}

/** The public shape of stored values: the cover's URL and size, never its key. */
export function publicSaleMetadata(stored: StoredSaleMetadata): SocialSaleMetadata {
  return {
    tagline: stored.tagline,
    site: stored.site,
    x_handle: stored.x_handle,
    telegram: stored.telegram,
    docs_url: stored.docs_url,
    audit_url: stored.audit_url,
    cover: publicCover(stored.cover),
    launch_at_ms: stored.launch_at_ms,
  };
}

/** A row's public details from the columns `SALE_METADATA_COLUMNS` selects (all null without a row). */
export function saleMetadataOf(row: SaleMetadataRow): SocialSaleMetadata {
  return publicSaleMetadata(storedOf(row));
}

const READ_SQL = `SELECT ${SALE_METADATA_COLUMNS("m")} FROM social_sale_metadata m WHERE m.presale_id = $1`;

/** The stored values of a sale (empty without a row). */
export async function readStoredSaleMetadata(db: ReadableDatabase, presaleId: string): Promise<StoredSaleMetadata> {
  return storedOf((await db.read<SaleMetadataRow>(READ_SQL, [presaleId])).rows[0]);
}

/** A sale the web shows, with its lifecycle, or null (`SHOWN_PRESALES`, one primary-key probe). */
export async function readShownSaleLifecycle(db: ReadableDatabase, presaleId: string): Promise<string | null> {
  const { rows } = await db.read<{ lifecycle: string }>(`SELECT p.lifecycle FROM ${SHOWN_PRESALES} p WHERE p.presale_id = $1`, [presaleId]);
  return rows[0]?.lifecycle ?? null;
}

/** `before` as an edit row records it: every value column, the cover's included. */
function beforeJson(stored: StoredSaleMetadata): string {
  const { cover, ...fields } = stored;
  return JSON.stringify({
    ...fields,
    cover_key: cover?.key ?? null,
    cover_url: cover?.url ?? null,
    cover_width: cover?.width ?? null,
    cover_height: cover?.height ?? null,
    cover_source_width: cover?.source?.width ?? null,
    cover_source_height: cover?.source?.height ?? null,
  });
}

/** Stored values from an edit row's `before`, or null when it is not one (the operator's revert). */
export function storedFromBefore(before: unknown): StoredSaleMetadata | null {
  const metadataShape = Object.fromEntries(SALE_METADATA_FIELDS.map((field) => [field, z.string().nullable()])) as Record<SaleMetadataField, z.ZodNullable<z.ZodString>>;
  const parsed = z.object({
    ...metadataShape,
    launch_at_ms: z.number().int().nullable(), cover_key: z.string().nullable().catch(null),
    cover_url: z.string().nullable().catch(null), cover_width: z.number().nullable().catch(null), cover_height: z.number().nullable().catch(null),
    // Edits logged before 0137 hold no upload size.
    cover_source_width: z.number().nullable().catch(null), cover_source_height: z.number().nullable().catch(null),
  }).safeParse(before);
  if (!parsed.success) return null;
  const value = parsed.data;
  const row: SaleMetadataRow = {
    ...Object.fromEntries(SALE_METADATA_FIELDS.map((field) => [field, value[field]])) as Record<SaleMetadataField, string | null>,
    launch_at_ms: value.launch_at_ms === null ? null : String(value.launch_at_ms),
    cover_key: value.cover_key, cover_url: value.cover_url, cover_width: value.cover_width, cover_height: value.cover_height,
    cover_source_width: value.cover_source_width, cover_source_height: value.cover_source_height,
  };
  return storedOf(row);
}

export function sameStored(a: StoredSaleMetadata, b: StoredSaleMetadata): boolean {
  return beforeJson(a) === beforeJson(b);
}

const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('social_sale_metadata'), hashtext($1))";
const NOW_MS = "(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const EDIT_SQL = `INSERT INTO social_sale_metadata_edits (presale_id, account_id, operator_id, at_ms, before)
  VALUES ($1, $2::uuid, $3, ${NOW_MS}, $4::jsonb)
  RETURNING edit_id::text`;
const UPSERT_SQL = `INSERT INTO social_sale_metadata (
    presale_id, tagline, site, x_handle, telegram, docs_url, audit_url, launch_at_ms,
    cover_key, cover_url, cover_width, cover_height, cover_source_width, cover_source_height,
    updated_by_account_id, updated_by_operator, updated_at_ms
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10, $11, $12, $13, $14, $15::uuid, $16, ${NOW_MS})
  ON CONFLICT (presale_id) DO UPDATE SET
    tagline = EXCLUDED.tagline, site = EXCLUDED.site, x_handle = EXCLUDED.x_handle, telegram = EXCLUDED.telegram,
    docs_url = EXCLUDED.docs_url, audit_url = EXCLUDED.audit_url, launch_at_ms = EXCLUDED.launch_at_ms,
    cover_key = EXCLUDED.cover_key, cover_url = EXCLUDED.cover_url, cover_width = EXCLUDED.cover_width,
    cover_height = EXCLUDED.cover_height, cover_source_width = EXCLUDED.cover_source_width,
    cover_source_height = EXCLUDED.cover_source_height, updated_by_account_id = EXCLUDED.updated_by_account_id,
    updated_by_operator = EXCLUDED.updated_by_operator, updated_at_ms = EXCLUDED.updated_at_ms`;

export type SaleMetadataChange = Readonly<Partial<StoredSaleMetadata>>;

export type SaleMetadataWrite = Readonly<{
  before: StoredSaleMetadata;
  stored: StoredSaleMetadata;
  /** False when the change matched what was stored: no edit row, nothing written. */
  changed: boolean;
  /** The edit row written, or null when nothing changed. */
  editId: string | null;
}>;

/**
 * Applies `change` (a key present is set, absent is kept) to the sale's row
 * under its lock. Nothing is written when it changes nothing; otherwise one
 * edit row with the values before, then the row.
 */
export async function writeSaleMetadata(
  social: ModuleTransaction<"social">,
  presaleId: string,
  change: SaleMetadataChange,
  author: SaleMetadataAuthor,
): Promise<SaleMetadataWrite> {
  await social.read(LOCK_SQL, [presaleId]);
  const before = await readStoredSaleMetadata(social, presaleId);
  const stored: StoredSaleMetadata = { ...before, ...change };
  if (sameStored(before, stored)) return { before, stored: before, changed: false, editId: null };
  const accountId = "accountId" in author ? author.accountId : null;
  const operatorId = "operatorId" in author ? author.operatorId : null;
  const { rows } = await social.write<{ edit_id: string }>("social_sale_metadata_edits", EDIT_SQL, [presaleId, accountId, operatorId, beforeJson(before)]);
  await social.write("social_sale_metadata", UPSERT_SQL, [
    presaleId,
    stored.tagline,
    stored.site,
    stored.x_handle,
    stored.telegram,
    stored.docs_url,
    stored.audit_url,
    stored.launch_at_ms,
    stored.cover?.key ?? null,
    stored.cover?.url ?? null,
    stored.cover?.width ?? null,
    stored.cover?.height ?? null,
    stored.cover?.source?.width ?? null,
    stored.cover?.source?.height ?? null,
    accountId,
    operatorId,
  ]);
  return { before, stored, changed: true, editId: rows[0]!.edit_id };
}
