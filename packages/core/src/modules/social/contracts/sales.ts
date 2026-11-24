import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * A published sale's public details (R3-24; OA-25 Q5 and Q7): its cover
 * image, its one-line description (`tagline`) and its outbound links, plus
 * the published launch date. Blast metadata, not contract terms: the chain
 * holds the terms, and nothing here can change one. Stored in
 * `social_sale_metadata` (0090); every change appends an insert-only
 * `social_sale_metadata_edits` row the operator CLI can revert.
 *
 * - `GET /api/social/sales/{presale_id}/metadata`: the stored details and
 *   whether the caller may edit them (`sale-metadata-response`). Account
 *   required, `private, no-store`, bucket `social_read`.
 * - `PUT /api/social/sales/{presale_id}/metadata` (`sale-metadata-request`):
 *   a closed body of the six text fields, each optional. A present field is
 *   set (an empty string or null clears it); an absent one is unchanged. The
 *   answer is the stored details. Bucket `social_account_update`. The same
 *   body twice stores one edit.
 * - `POST /api/social/sales/{presale_id}/cover`: `multipart/form-data` with
 *   one `cover` file (PNG, JPEG or WebP, at most `SALE_COVER_MAX_BYTES`),
 *   re-encoded to a 1536 × 512 WebP in the public launch-asset store; `201`
 *   with the details. The previous cover's object is deleted once the row
 *   names the new one. Bucket `social_picture_upload`.
 * - `DELETE /api/social/sales/{presale_id}/cover`: removes the cover and its
 *   object; `204`, harmless to repeat. Bucket `social_account_update`.
 *
 * Every write: `401 unauthorized` without a session, `409 account_required`
 * without an account, `404 not_found` for a sale the web does not show,
 * `403 not_sale_creator` unless one of the caller's wallets holds the sale's
 * `PresaleCap` (the sale's creator; see `sales/editor.ts`), `409
 * sale_cancelled` for a cancelled sale, and the field codes below.
 *
 * The public reads (`GET /api/social/presales`, `/presales/{id}`) carry the
 * details as `metadata` on every sale summary; they never name who wrote them.
 */

const SOCIAL_SALES_PATH = "/api/social/sales";
export const SOCIAL_SALE_METADATA_READ_ROUTE = "GET /api/social/sales/{presale_id}/metadata";
export const SOCIAL_SALE_METADATA_ROUTE = "PUT /api/social/sales/{presale_id}/metadata";
export const SOCIAL_SALE_COVER_UPLOAD_ROUTE = "POST /api/social/sales/{presale_id}/cover";
export const SOCIAL_SALE_COVER_DELETE_ROUTE = "DELETE /api/social/sales/{presale_id}/cover";

/** `/api/social/sales/{presale_id}/metadata`. */
export function socialSaleMetadataPath(presaleId: string): string {
  return `${SOCIAL_SALES_PATH}/${encodeURIComponent(presaleId)}/metadata`;
}

/** `/api/social/sales/{presale_id}/cover`. */
export function socialSaleCoverPath(presaleId: string): string {
  return `${SOCIAL_SALES_PATH}/${encodeURIComponent(presaleId)}/cover`;
}

/** The longest tagline, in Unicode code points. */
export const SALE_TAGLINE_MAX = 120;
/** The longest stored link. */
export const SALE_LINK_MAX = 512;
/** X handles: 1 to 15 of `[A-Za-z0-9_]`. */
export const SALE_X_HANDLE_MAX = 15;
/** Telegram names: 5 to 32 of `[A-Za-z0-9_]`. */
export const SALE_TELEGRAM_MIN = 5;
export const SALE_TELEGRAM_MAX = 32;

/** The six fields a creator writes (the request's whole vocabulary: no term is one of them). */
export const SALE_METADATA_FIELDS = ["tagline", "site", "x_handle", "telegram", "docs_url", "audit_url"] as const;
export type SaleMetadataField = (typeof SALE_METADATA_FIELDS)[number];
/** The three link fields stored as URLs. */
export const SALE_LINK_FIELDS = ["site", "docs_url", "audit_url"] as const satisfies readonly SaleMetadataField[];
export type SaleLinkField = (typeof SALE_LINK_FIELDS)[number];

/** `PUT …/metadata`: each field optional; a string sets it (blank clears), null clears it. */
export type SaleMetadataRequest = Readonly<z.infer<typeof saleMetadataRequestSchema>>;

export const SALE_COVER_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** The largest cover upload (the gate's `Use an image under 4 MB`). */
export const SALE_COVER_MAX_BYTES = 4_000_000;
/** The stored cover: a 3:1 WebP. */
export const SALE_COVER_WIDTH = 1_536;
export const SALE_COVER_HEIGHT = 512;
/** The multipart field that carries the cover file. */
export const SALE_COVER_FIELD = "cover";
export const SALE_COVER_REJECTIONS = ["type", "undecodable", "animated", "dimensions"] as const;
export type SaleCoverRejection = (typeof SALE_COVER_REJECTIONS)[number];

/** The size, in pixels after its EXIF orientation, of the image a cover was made from. */
export type SaleCoverSource = Readonly<{ width: number; height: number }>;

/**
 * A stored cover: the 3:1 WebP's URL and size, and the size of the upload it
 * came from (`source`). The server always sends `source`: null for a cover
 * stored before uploads were measured (0137). It is optional only so a page
 * rendered from an older response still reads.
 */
export type SocialSaleCover = Readonly<{ url: string; width: number; height: number; source?: SaleCoverSource | null }>;

/** A sale's public details as every read shows them: no editor, no time, nothing but the values. */
export type SocialSaleMetadata = Readonly<z.infer<typeof socialSaleMetadataSchema>>;

/** `GET`/`PUT …/metadata` and `POST …/cover`: the stored details, and whether the caller may change them. */
export type SocialSaleMetadataResponse = Readonly<z.infer<typeof socialSaleMetadataResponseSchema>>;

/** Details with nothing set (a sale without a row). */
export const EMPTY_SALE_METADATA: SocialSaleMetadata = Object.freeze({
  tagline: null,
  site: null,
  x_handle: null,
  telegram: null,
  docs_url: null,
  audit_url: null,
  cover: null,
  launch_at_ms: null,
});

/** Whether `metadata` holds anything a page would show. */
export function hasSaleMetadata(metadata: SocialSaleMetadata | null | undefined): metadata is SocialSaleMetadata {
  return Boolean(metadata && (metadata.cover || metadata.launch_at_ms !== null || SALE_METADATA_FIELDS.some((field) => metadata[field] !== null)));
}

// Published shapes deliberately keep nullable oneOf branches and fragment paths stable.
export const saleCoverSourceSchema = z.strictObject({
  width: z.number().min(1).max(8192).refine(Number.isInteger).meta({"type": "integer"}),
  height: z.number().min(1).max(8192).refine(Number.isInteger).meta({"type": "integer"}),
});

export const socialSaleCoverSourceSchema = z.xor([z.null(), saleCoverSourceSchema]).meta({"description": "The size, in pixels after its EXIF orientation, of the image the cover was made from; null for a cover stored before uploads were measured."});

export const socialSaleCoverSchema = z.strictObject({
  url: z.string().regex(new RegExp("^https://[^\\s]+$", "u")).refine((value) => [...value].length <= 2048).meta({"maxLength": 2048}),
  width: z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}),
  height: z.number().min(1).refine(Number.isInteger).meta({"type": "integer"}),
  source: socialSaleCoverSourceSchema.optional(),
});

export const saleMetadataRequestSchema = z.strictObject({
  tagline: z.xor([z.null(), z.string().refine((value) => [...value].length <= 1024).meta({"maxLength": 1024})]).optional(),
  site: z.xor([z.null(), z.string().refine((value) => [...value].length <= 1024).meta({"maxLength": 1024})]).optional(),
  x_handle: z.xor([z.null(), z.string().refine((value) => [...value].length <= 1024).meta({"maxLength": 1024})]).optional(),
  telegram: z.xor([z.null(), z.string().refine((value) => [...value].length <= 1024).meta({"maxLength": 1024})]).optional(),
  docs_url: z.xor([z.null(), z.string().refine((value) => [...value].length <= 1024).meta({"maxLength": 1024})]).optional(),
  audit_url: z.xor([z.null(), z.string().refine((value) => [...value].length <= 1024).meta({"maxLength": 1024})]).optional(),
}).meta({"title": "Sale metadata request", "description": "PUT /api/social/sales/{presale_id}/metadata (R3-24): the creator's six text fields, each optional; a string sets it (blank clears), null clears it, an absent field is unchanged. Closed: no term of the sale is a field, so a request naming one is 400 invalid_request."});

export const socialSaleMetadataSchema = z.strictObject({
  tagline: z.xor([z.null(), z.string().refine((value) => [...value].length >= 1).refine((value) => [...value].length <= SALE_TAGLINE_MAX).meta({"minLength": 1, "maxLength": SALE_TAGLINE_MAX})]),
  site: z.xor([z.null(), z.string().regex(new RegExp("^https://[^\\s/?#@:]+(/[^\\s#]*)?$", "u")).refine((value) => [...value].length <= 512).meta({"maxLength": 512})]),
  x_handle: z.xor([z.null(), z.string().regex(new RegExp("^[A-Za-z0-9_]{1,15}$", "u"))]),
  telegram: z.xor([z.null(), z.string().regex(new RegExp("^[A-Za-z0-9_]{5,32}$", "u"))]),
  docs_url: z.xor([z.null(), z.string().regex(new RegExp("^https://[^\\s/?#@:]+(/[^\\s#]*)?$", "u")).refine((value) => [...value].length <= 512).meta({"maxLength": 512})]),
  audit_url: z.xor([z.null(), z.string().regex(new RegExp("^https://[^\\s/?#@:]+(/[^\\s#]*)?$", "u")).refine((value) => [...value].length <= 512).meta({"maxLength": 512})]),
  cover: z.xor([z.null(), socialSaleCoverSchema]),
  launch_at_ms: z.xor([z.null(), z.number().min(1).refine(Number.isInteger).meta({"type": "integer"})]),
}).meta({"title": "Sale metadata", "description": "R3-24 (contracts/sales.ts SocialSaleMetadata): a sale's public details. A tagline is one plain line, never auto-linked; links are https URLs with no userinfo or port; handles are bare. An audit link never implies an Audited badge."});

export const socialSaleMetadataResponseSchema = z.strictObject({
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  metadata: socialSaleMetadataSchema,
  editable: z.boolean(),
}).meta({"title": "Sale metadata response", "description": "GET/PUT /api/social/sales/{presale_id}/metadata and POST …/cover (R3-24), private, no-store: the stored details (all null without a row) and whether the caller may change them."});
