import { z } from "zod";

import { diagnosticMessage } from "#web/lib/errors.ts";
import {
  SALE_COVER_MAX_BYTES,
  SALE_TAGLINE_MAX,
  socialSaleCoverPath,
  socialSaleMetadataPath,
  socialSaleMetadataResponseSchema,
  type SaleMetadataField,
  type SaleMetadataRequest,
  type SocialSaleMetadata,
  type SocialSaleMetadataResponse,
} from "@blast/core/web/contracts/sales.ts";
import {
  bareTelegram,
  bareXHandle,
  normalizeSaleLink,
  normalizeSaleTagline,
  normalizeTelegram,
  normalizeXHandle,
} from "@blast/core/modules/social/sales/validate.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * The sale page's details (R3-28, on R3-24's routes): the fields of the
 * creator's "Edit details" sheet, what each says when it is wrong (the gate's
 * words), and the calls. Every call goes through `callSocialApi`, so a Slush
 * session sends only its wallet cookie (OA-16).
 */

export type EditDetailsField = Readonly<{
  /** The metadata column the input writes: the sheet has no other kind of field. */
  key: SaleMetadataField;
  label: string;
  placeholder: string;
  pre?: string;
  maxLength: number;
}>;

/** The sheet's inputs, in the gate's order. Every one is a metadata column; none is a term of the sale. */
export const EDIT_DETAILS_FIELDS: readonly EditDetailsField[] = Object.freeze([
  { key: "tagline", label: "One line about it", placeholder: "What it does, in a line", maxLength: SALE_TAGLINE_MAX * 2 },
  { key: "site", label: "Website", placeholder: "meridian.finance", maxLength: 120 },
  { key: "x_handle", label: "X", placeholder: "meridianfx", pre: "@", maxLength: 15 },
  { key: "telegram", label: "Telegram", placeholder: "meridianfx", pre: "t.me/", maxLength: 32 },
  { key: "docs_url", label: "Docs", placeholder: "docs.meridian.finance", maxLength: 120 },
  { key: "audit_url", label: "Audit report", placeholder: "Link to the PDF or page", maxLength: 160 },
]);

export type EditDetailsValues = Readonly<Record<SaleMetadataField, string>>;

/** What the inputs show for stored details: links without their scheme, as the gate shows them. */
export function editValuesOf(metadata: SocialSaleMetadata | null): EditDetailsValues {
  const bare = (url: string | null) => (url ?? "").replace(/^https?:\/\//i, "");
  return {
    tagline: metadata?.tagline ?? "",
    site: bare(metadata?.site ?? null),
    x_handle: metadata?.x_handle ?? "",
    telegram: metadata?.telegram ?? "",
    docs_url: bare(metadata?.docs_url ?? null),
    audit_url: bare(metadata?.audit_url ?? null),
  };
}

/** A typed value as the input keeps it: a pasted X or Telegram link (or `@`) becomes the bare handle. */
export function editInputValue(key: SaleMetadataField, value: string): string {
  if (key === "x_handle") return bareXHandle(value);
  if (key === "telegram") return bareTelegram(value);
  return value;
}

const NOT_A_LINK = "That isn't a web address";

/** The field's inline error in the gate's words, or "" when it is fine (blank is fine: every field is optional). */
export function editFieldMessage(key: SaleMetadataField, value: string): string {
  switch (key) {
    case "tagline": {
      const checked = normalizeSaleTagline(value);
      if (checked.ok) return "";
      return checked.code === "tagline_too_long"
        ? `Keep it to ${SALE_TAGLINE_MAX} characters`
        : checked.code === "tagline_has_link"
          ? "Links go in the fields below"
          : "Keep it to one line";
    }
    case "x_handle":
      return normalizeXHandle(value).ok ? "" : "Up to 15 letters, digits or _";
    case "telegram":
      return normalizeTelegram(value).ok ? "" : "5 to 32 letters, digits or _";
    default:
      return normalizeSaleLink(value).ok ? "" : NOT_A_LINK;
  }
}

/** The request a save sends: every field, so what the sheet shows is what is stored. */
export function editRequestOf(values: EditDetailsValues): SaleMetadataRequest {
  return { ...values };
}

/** Whether a picked cover may be sent (the gate refuses one over 4 MB before reading it). */
export function coverTooLarge(file: Blob): boolean {
  return file.size > SALE_COVER_MAX_BYTES;
}

/** A refusal as the sheet or a toast says it. */
export function saleDetailsRefusal(result: ApiResult<unknown>): string {
  if (result.status !== "refused") return diagnosticMessage("That didn't save. Nothing changed; try again in a moment.", result);
  switch (result.code) {
    case "body_too_large":
      return diagnosticMessage("Use an image under 4 MB", result);
    case "invalid_cover":
      return diagnosticMessage("Use a still PNG, JPEG or WebP image, at least 128 pixels on each side", result);
    case "cover_upload_unavailable":
      return diagnosticMessage("Cover uploads aren’t available right now", result);
    case "blocked_term":
      return diagnosticMessage("That line has a word Blast doesn’t allow", result);
    case "tagline_has_link":
      return diagnosticMessage("Links go in the fields below", result);
    case "invalid_link":
      return diagnosticMessage(NOT_A_LINK, result);
    case "not_sale_creator":
      return diagnosticMessage("Only the sale’s creator can change its details", result);
    case "sale_cancelled":
      return diagnosticMessage("This sale was cancelled, so its details can’t change", result);
    case "rate_limited":
      return diagnosticMessage("That’s a lot of changes. Try again in a few minutes.", result);
    default:
      return diagnosticMessage("That didn't save. Nothing changed; try again in a moment.", result);
  }
}

const emptySaleResponseSchema = z.null();

export function fetchSaleDetails(options: SocialApiOptions, presaleId: string): Promise<ApiResult<SocialSaleMetadataResponse>> {
  return callSocialApi(options, socialSaleMetadataPath(presaleId), { method: "GET" }, socialSaleMetadataResponseSchema);
}

export function saveSaleDetails(options: SocialApiOptions, presaleId: string, request: SaleMetadataRequest): Promise<ApiResult<SocialSaleMetadataResponse>> {
  return callSocialApi(options, socialSaleMetadataPath(presaleId), { method: "PUT", body: request }, socialSaleMetadataResponseSchema);
}

export function uploadSaleCover(options: SocialApiOptions, presaleId: string, file: Blob): Promise<ApiResult<SocialSaleMetadataResponse>> {
  const form = new FormData();
  form.set("cover", file);
  return callSocialApi(options, socialSaleCoverPath(presaleId), { method: "POST", form }, socialSaleMetadataResponseSchema);
}

export function removeSaleCover(options: SocialApiOptions, presaleId: string): Promise<ApiResult<null>> {
  return callSocialApi(options, socialSaleCoverPath(presaleId), { method: "DELETE" }, emptySaleResponseSchema);
}
