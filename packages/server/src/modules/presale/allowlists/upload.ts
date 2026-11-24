import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";

import type { AllowlistEntry } from "@interest-protocol/blast-sdk/presale";

import type { AllowlistWarning } from "@blast/core/modules/presale/contracts/web-api.ts";
import {
  allowlistUploadEnvelopeSchema,
  allowlistUploadRowSchema,
} from "@blast/core/modules/presale/contracts/allowlist-request.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { readBoundedBody } from "@blast/core/modules/presale/route-kit/route.ts";

/** The largest upload, multipart or JSON, in bytes (4 MiB). */
export const ALLOWLIST_BODY_LIMIT_BYTES = 4 * 1_024 * 1_024;
/** The most data rows (entries) one allowlist holds: the contract's 65,536 participants. */
export const ALLOWLIST_MAX_ROWS = 65_536;
/** At most this many row errors are reported. */
export const ALLOWLIST_MAX_ROW_ERRORS = 100;
/** At most this many rows get their own `normalized_address` warning; one summary item counts the rest. */
export const ALLOWLIST_MAX_ROW_WARNINGS = 100;

const U64_MAX = (1n << 64n) - 1n;
const uploadAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((value) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`);
const uploadQuoteSchema = z
  .string()
  .refine(isValidStructTag)
  .transform((value) => normalizeStructTag(value));
const multipartNamesSchema = z.array(z.enum(["file", "quote", "include_blast_holders"]))
  .refine((names) => new Set(names).size === names.length && names.includes("file") && names.includes("quote"));
const csvHeaderSchema = z.tuple([z.literal("wallet"), z.literal("cap")]);
const csvFieldsSchema = z.tuple([z.string(), z.string()]);
const uploadCapSchema = z
  .string({ error: "cap must be a base-10 integer string" })
  .superRefine((cap, context) => {
    let reason: string | undefined;
    if (/^-[0-9]+$/.test(cap)) reason = "cap must be at least 1";
    else if (!/^[0-9]+$/.test(cap)) reason = "cap must be a base-10 integer";
    else if (cap.replace(/^0+/, "").length > 20) reason = "cap exceeds the u64 maximum";
    else if (BigInt(cap) === 0n) reason = "cap must be at least 1";
    else if (BigInt(cap) > U64_MAX) reason = "cap exceeds the u64 maximum";
    if (reason) context.addIssue({ code: "custom", message: reason });
  })
  .transform(BigInt);

export type AllowlistUpload = Readonly<{
  /** The normalized Quote coin type. */
  quote: string;
  /** In row order: entry index = data row - 1. */
  entries: AllowlistEntry[];
  warnings: AllowlistWarning[];
  includeBlastHolders?: boolean;
  fileName?: string;
}>;

type RowError = { row: number; reason: string };

/**
 * Reads `POST /api/presale/allowlists`: multipart/form-data with a CSV file
 * part `file` and a field `quote` (CL-6c), or JSON `{ quote, entries }`.
 *
 * - Over 4 MiB, declared or streamed, or over 65,536 data rows:
 *   `allowlist_too_large`.
 * - A malformed body, header, quote or an empty list: `invalid_request`.
 * - Invalid rows: `invalid_allowlist` with every offending row and reason,
 *   the first 100 (CL-6a).
 * - A short address is left-padded with a `normalized_address` warning for
 *   its row, for the first 100 such rows; one row-less item counts the rest
 *   (CL-6b), so the stored and returned warnings stay small.
 *
 * Nothing here logs or echoes the upload's content.
 */
export async function readAllowlistUpload(request: Request): Promise<AllowlistUpload> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "multipart/form-data" && type !== "application/json")
    throw new PresaleRouteError("invalid_request");
  const body = await readBoundedBody(request, {
    maxBytes: ALLOWLIST_BODY_LIMIT_BYTES,
    tooLarge: "allowlist_too_large",
  });
  return type === "application/json"
    ? fromJson(body)
    : fromMultipart(body, request.headers.get("content-type") ?? "");
}

function utf8(bytes: Uint8Array): string {
  try {
    // The decoder drops a leading BOM.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PresaleRouteError("invalid_request");
  }
}

function quote(value: unknown): string {
  const parsed = uploadQuoteSchema.safeParse(value);
  if (!parsed.success) throw new PresaleRouteError("invalid_request");
  return parsed.data;
}

async function fromMultipart(
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<AllowlistUpload> {
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new PresaleRouteError("invalid_request");
  }
  const names = [...form.keys()];
  const part = z.instanceof(File).safeParse(form.get("file"));
  if (!multipartNamesSchema.safeParse(names).success || !part.success) {
    throw new PresaleRouteError("invalid_request");
  }
  const file = part.data;
  const lines = utf8(new Uint8Array(await file.arrayBuffer())).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const header = lines[0]?.split(",").map((name) => name.trim().toLowerCase());
  if (!csvHeaderSchema.safeParse(header).success)
    throw new PresaleRouteError("invalid_request");
  const rows = lines.slice(1);
  const parsedQuote = quote(form.get("quote"));
  const parsed = entries(parsedQuote, rows.length, (index) => {
    const fields = csvFieldsSchema.safeParse(rows[index].split(","));
    return fields.success ? { wallet: fields.data[0].trim(), cap: fields.data[1].trim() } : null;
  });
  const include = form.get("include_blast_holders");
  if (!z.enum(["true", "false"]).nullable().safeParse(include).success)
    throw new PresaleRouteError("invalid_request");
  return { ...parsed, includeBlastHolders: include === "true", fileName: file.name.slice(0, 200) };
}

function fromJson(body: Uint8Array): AllowlistUpload {
  let value: unknown;
  try {
    value = JSON.parse(utf8(body));
  } catch {
    throw new PresaleRouteError("invalid_request");
  }
  const envelope = allowlistUploadEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw new PresaleRouteError("invalid_request");
  const record = envelope.data;
  const list = record.entries;
  if (list.length > ALLOWLIST_MAX_ROWS) throw new PresaleRouteError("allowlist_too_large");
  const parsedQuote = quote(record.quote);
  if (!z.boolean().optional().safeParse(record.include_blast_holders).success)
    throw new PresaleRouteError("invalid_request");
  const parsed = entries(parsedQuote, list.length, (index) => {
    const entry = allowlistUploadRowSchema.safeParse(list[index]);
    return entry.success ? entry.data : null;
  });
  return { ...parsed, includeBlastHolders: record.include_blast_holders === true };
}

/**
 * Validates `count` rows in order. `row(index)` gives a row's raw wallet and
 * cap, or null when the row does not have exactly those two values.
 */
function entries(
  parsedQuote: string,
  count: number,
  row: (index: number) => { wallet: unknown; cap: unknown } | null,
): AllowlistUpload {
  if (count > ALLOWLIST_MAX_ROWS) throw new PresaleRouteError("allowlist_too_large");
  if (count === 0) throw new PresaleRouteError("invalid_request");
  const result: AllowlistEntry[] = [];
  const warnings: AllowlistWarning[] = [];
  const errors: RowError[] = [];
  const firstRow = new Map<string, number>();
  let padded = 0;
  const fail = (rowNumber: number, reason: string) => {
    if (errors.length < ALLOWLIST_MAX_ROW_ERRORS) errors.push({ row: rowNumber, reason });
  };
  const appendRow = (index: number) => {
    const rowNumber = index + 1;
    const raw = row(index);
    if (!raw) {
      fail(rowNumber, "a row needs exactly a wallet and a cap");
      return;
    }
    const address = uploadAddressSchema.safeParse(raw.wallet);
    const cap = uploadCapSchema.safeParse(raw.cap);
    const wallet = address.success ? address.data : null;
    const reason = cap.success ? null : cap.error.issues[0].message;
    if (wallet === null) fail(rowNumber, "invalid address");
    if (reason) fail(rowNumber, reason);
    if (wallet === null) return;
    const first = firstRow.get(wallet);
    if (first !== undefined) {
      fail(rowNumber, `duplicate wallet (first on row ${first})`);
      return;
    }
    firstRow.set(wallet, rowNumber);
    if (reason) return;
    if ((raw.wallet as string).length < 66) {
      padded += 1;
      if (padded <= ALLOWLIST_MAX_ROW_WARNINGS) {
        warnings.push({
          code: "normalized_address",
          message: `Row ${rowNumber}'s address was left-padded to 64 hex characters.`,
          row: rowNumber,
        });
      }
    }
    if (cap.success) result.push({ wallet, walletCap: cap.data });
  };
  for (let index = 0; index < count; index += 1) appendRow(index);
  if (errors.length > 0)
    throw new PresaleRouteError("invalid_allowlist", { extra: { rows: errors } });
  if (padded > ALLOWLIST_MAX_ROW_WARNINGS) {
    warnings.push({
      code: "normalized_address",
      message: `${padded - ALLOWLIST_MAX_ROW_WARNINGS} more rows normalized`,
    });
  }
  return { quote: parsedQuote, entries: result, warnings };
}
