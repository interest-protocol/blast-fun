import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { createHash } from "node:crypto";

export const PRESALE_RECEIPT_SCHEMA = "blast.presale-receipt" as const;
export const PRESALE_RECEIPT_VERSION = 1 as const;
/** The coin logo is stored and drawn as a PNG square of this many pixels. */
export const PRESALE_RECEIPT_LOGO_SIZE = 512;

/** The sale coin's logo after the fetch guard: a normalized PNG square and its digest. */
export interface PresaleReceiptLogo {
  readonly sha256: string;
  /** Base64 of the normalized PNG. */
  readonly bytes: string;
}

/**
 * What a presale receipt image shows (T-012). It is built from the
 * participant's commit on blast-infra, the coins' `Currency` metadata and the
 * wallet's crew, and its digest names the rendered pixels.
 */
export interface PresaleReceiptRecord {
  readonly schema: typeof PRESALE_RECEIPT_SCHEMA;
  readonly version: typeof PRESALE_RECEIPT_VERSION;
  readonly presaleId: string;
  readonly wallet: string;
  readonly saleToken: string;
  readonly quote: string;
  /** The last commit's running `wallet_commitment`, in Quote atoms (u64 decimal string). */
  readonly amountCommitted: string;
  readonly quoteSymbol: string;
  readonly quoteDecimals: number;
  readonly coinName: string;
  readonly coinSymbol: string;
  readonly logo: PresaleReceiptLogo | null;
  /** The wallet's crew number, or null when it is not linked to a crew member. */
  readonly crew: number | null;
}

export class PresaleReceiptInputError extends Error {
  readonly name = "PresaleReceiptInputError";
}

export const RECEIPT_NAME_MAX = 32;
export const RECEIPT_SYMBOL_MAX = 16;
const KEYS = [
  "schema", "version", "presaleId", "wallet", "saleToken", "quote", "amountCommitted", "quoteSymbol",
  "quoteDecimals", "coinName", "coinSymbol", "logo", "crew",
] as const;
const COIN_TYPE = /^0x[0-9a-f]{64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(?:<.+>)?$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LOGO_MAX_BYTES = 4 * 1024 * 1024;
// C0 and C1 controls, and bidirectional overrides, never reach a public image.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Untrusted display text (on-chain coin names and symbols) as the receipt
 * prints it: controls removed, whitespace collapsed, and anything longer than
 * `max` characters shortened with an ellipsis. Applying it twice changes
 * nothing, so a stored record re-validates to itself.
 */
export function receiptDisplayText(value: string, max: number): string {
  const text = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : text;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || receiptDisplayText(value, max) !== value) {
    throw new PresaleReceiptInputError(`${label} must be 1-${max} printable characters.`);
  }
  return value;
}

function pattern(value: unknown, label: string, expression: RegExp, maxLength = 512): string {
  if (typeof value !== "string" || value.length > maxLength || !expression.test(value)) {
    throw new PresaleReceiptInputError(`${label} is malformed.`);
  }
  return value;
}

function logoOf(value: unknown): PresaleReceiptLogo | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new PresaleReceiptInputError("logo must be an object or null.");
  const { sha256, bytes, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new PresaleReceiptInputError("logo has unknown fields.");
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new PresaleReceiptInputError("logo sha256 is malformed.");
  if (typeof bytes !== "string" || !bytes || !BASE64.test(bytes)) throw new PresaleReceiptInputError("logo bytes must be base64.");
  const decoded = Buffer.from(bytes, "base64");
  if (decoded.length > LOGO_MAX_BYTES || !decoded.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PresaleReceiptInputError("logo must be a PNG.");
  }
  if (createHash("sha256").update(decoded).digest("hex") !== sha256) {
    throw new PresaleReceiptInputError("logo sha256 does not match its bytes.");
  }
  return Object.freeze({ sha256, bytes });
}

/** A logo from normalized PNG bytes (the fetch guard's output). */
export function createPresaleReceiptLogo(png: Uint8Array): PresaleReceiptLogo {
  const bytes = Buffer.from(png);
  return logoOf({ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.toString("base64") })!;
}

/** Validates a receipt record exactly; the result is frozen and re-validates to itself. */
export function createPresaleReceiptRecord(input: unknown): PresaleReceiptRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PresaleReceiptInputError("A receipt record must be an object.");
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown.length) throw new PresaleReceiptInputError(`Unknown receipt fields: ${unknown.join(", ")}.`);
  if (record.schema !== PRESALE_RECEIPT_SCHEMA || record.version !== PRESALE_RECEIPT_VERSION) {
    throw new PresaleReceiptInputError("Unsupported receipt schema or version.");
  }
  const amountCommitted = pattern(record.amountCommitted, "amountCommitted", U64, 20);
  if (BigInt(amountCommitted) > U64_MAX) throw new PresaleReceiptInputError("amountCommitted exceeds u64.");
  const { quoteDecimals, crew } = record;
  if (!Number.isInteger(quoteDecimals) || (quoteDecimals as number) < 0 || (quoteDecimals as number) > 38) {
    throw new PresaleReceiptInputError("quoteDecimals must be an integer from 0 through 38.");
  }
  if (crew !== null && (!Number.isSafeInteger(crew) || (crew as number) < 1)) {
    throw new PresaleReceiptInputError("crew must be a positive integer or null.");
  }
  return Object.freeze({
    schema: PRESALE_RECEIPT_SCHEMA,
    version: PRESALE_RECEIPT_VERSION,
    presaleId: pattern(record.presaleId, "presaleId", SUI_OBJECT_ID_PATTERN),
    wallet: pattern(record.wallet, "wallet", SUI_OBJECT_ID_PATTERN),
    saleToken: pattern(record.saleToken, "saleToken", COIN_TYPE),
    quote: pattern(record.quote, "quote", COIN_TYPE),
    amountCommitted,
    quoteSymbol: text(record.quoteSymbol, "quoteSymbol", RECEIPT_SYMBOL_MAX),
    quoteDecimals: quoteDecimals as number,
    coinName: text(record.coinName, "coinName", RECEIPT_NAME_MAX),
    coinSymbol: text(record.coinSymbol, "coinSymbol", RECEIPT_SYMBOL_MAX),
    logo: logoOf(record.logo),
    crew: crew as number | null,
  });
}

/**
 * Quote atoms in Quote units, grouped by thousands. A whole amount keeps at
 * most four decimals; an amount under one keeps every significant decimal.
 * Digits are cut, never rounded, so a receipt never shows more than was
 * committed.
 */
export function formatQuoteAmount(atoms: string, decimals: number): string {
  const digits = atoms.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const kept = (BigInt(whole) > 0n ? fraction.slice(0, 4) : fraction).replace(/0+$/, "");
  const grouped = BigInt(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return kept ? `${grouped}.${kept}` : grouped;
}
